import { execa } from "execa";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { digestFile, ensureDir, walkFiles, writeJsonAtomic } from "./files.js";
import { ARTIFACTS, paths } from "./paths.js";

/**
 * Controller-owned LaTeX compilation.
 *
 * In the Python this lives inside ContentRefinementAgent and a compile failure
 * merely `continue`s the reflection loop (content_refinement_agent.py:322-324),
 * so a manuscript that never compiled could still end a run. Here it is a
 * validator input: the agent has no `bash`, so "it compiles" is a fact the
 * controller establishes rather than a claim the model makes.
 */

/** Variables that make a build depend on the host's TeX tree rather than the workspace. */
const TEX_ENV_VARS = ["TEXINPUTS", "TEXMFHOME", "TEXMF", "TEXMFVAR", "TEXMFCONFIG"];

/**
 * Per-command timeout. The Python uses 30s (pdf_utils.py:169), which is tight
 * for a full paper with a bibliography and figures; a timeout there is
 * indistinguishable from a LaTeX error and costs a remediation round.
 */
const COMMAND_TIMEOUT_MS = 180_000;

export interface BuildResult {
  readonly ok: boolean;
  /** Absolute path to the PDF, when one was produced. */
  readonly pdf: string | null;
  readonly pages: number | null;
  /** The LaTeX errors worth showing a model, already trimmed. */
  readonly errors: string[];
  /** Unresolved `[?]` groups in the rendered text. */
  readonly unresolvedCitationMarks: number;
  /** Content that overflows its column, worst first. */
  readonly overfullBoxes: OverfullBox[];
  readonly log: string;
}

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !TEX_ENV_VARS.includes(key)) env[key] = value;
  }
  return env;
}

/**
 * Undo pdflatex's hard wrap.
 *
 * TeX breaks log lines at 79 columns, mid-word and mid-message, so a warning
 * can straddle two lines ("...undefined o" / "n input line 32."). Matching
 * against raw lines therefore misses or truncates messages. Joining a
 * continuation back onto its predecessor makes the log matchable.
 */
export function unwrapLog(log: string): string[] {
  const out: string[] = [];
  for (const raw of log.split("\n")) {
    const previous = out[out.length - 1];
    // A continuation is a full-width predecessor followed by a line that does
    // not begin a new message.
    if (
      previous !== undefined &&
      previous.length >= 79 &&
      raw.length > 0 &&
      !/^[!(\[]/.test(raw) &&
      !/^(LaTeX|Package|Overfull|Underfull|Class|Document|This is|Output)/.test(raw)
    ) {
      out[out.length - 1] = previous + raw;
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Extract the errors a model can act on.
 *
 * A pdflatex log is thousands of lines and mostly font chatter, so only errors
 * and undefined citation/reference warnings survive; the rest would bury the
 * fault in a remediation prompt.
 *
 * Citation warnings are matched from any package, not just LaTeX core. The
 * CVPR template loads natbib, which emits `Package natbib Warning: Citation
 * ... undefined` -- so a core-only pattern reported zero citation problems for
 * a manuscript whose every citation rendered as `[?]`.
 */
export function extractLatexErrors(log: string): string[] {
  const errors: string[] = [];
  const lines = unwrapLog(log);
  for (let at = 0; at < lines.length; at += 1) {
    const line = (lines[at] ?? "").trim();
    if (line.startsWith("!")) {
      const context = (lines[at + 1] ?? "").trim();
      errors.push(context ? `${line} ${context}` : line);
      continue;
    }
    // Undefined-REFERENCE warnings are reported; undefined-CITATION warnings
    // are not, because they are unreliable in both directions. The first
    // pdflatex pass necessarily runs before bibtex, so a perfectly healthy
    // build logs one per citation -- 25 of them on a manuscript whose
    // bibliography resolved completely. Whether citations actually resolved is
    // decided by `unresolvedCitationMarks`, which inspects the rendered text,
    // and by bibtex's own database-entry warnings below.
    if (/^(LaTeX|Package \S+) Warning: Reference .* undefined/.test(line)) {
      errors.push(line);
    }
    // bibtex writes this only when a key is genuinely absent from every
    // database it read, which makes it trustworthy where the pass-1 citation
    // warnings are not.
    if (/^Warning--I didn't find a database entry for/.test(line)) {
      errors.push(line);
    }
  }
  return [...new Set(errors)].slice(0, 25);
}

export interface OverfullBox {
  /** How far the content exceeds its column, in TeX points. */
  readonly points: number;
  /** Source line range, as TeX reports it. */
  readonly lines: string;
}

/**
 * Content wider than the column it sits in.
 *
 * TeX reports these as `Overfull \hbox (Xpt too wide)`, and they are the
 * mechanism behind visible layout damage: a table 41pt too wide for a CVPR
 * column spills across the gutter and lands on top of the neighbouring
 * column's text -- on a real run, on top of the References heading.
 *
 * Small overfulls are endemic in real papers and invisible in print, so callers
 * threshold rather than treating every one as a defect.
 */
export function extractOverfullBoxes(log: string): OverfullBox[] {
  const boxes: OverfullBox[] = [];
  for (const line of unwrapLog(log)) {
    const match = /^Overfull \\hbox \(([\d.]+)pt too wide\).*?(?:at lines?|in paragraph at lines) ([\d-]+)/.exec(
      line.trim(),
    );
    if (match?.[1]) {
      boxes.push({ points: Number(match[1]), lines: match[2] ?? "unknown" });
    }
  }
  return boxes.sort((a, b) => b.points - a.points);
}

/**
 * Count unresolved citation marks in the RENDERED text.
 *
 * This is the check that does not depend on knowing which package emits which
 * warning: a paper whose citations resolved contains no `[?]` groups. It caught
 * a run that every log-based check had passed, where bibtex had silently
 * produced an empty bibliography.
 */
export async function countUnresolvedCitationMarks(pdf: string): Promise<number> {
  try {
    const { stdout } = await execa("pdftotext", [pdf, "-"], { timeout: 60_000 });
    return (stdout.match(/\[[\s?,]*\?[\s?,]*\]/g) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Page count via Poppler's `pdfinfo`.
 *
 * Counting `/Type /Page` in the raw bytes does not work: pdflatex puts page
 * objects inside compressed object streams, so the markers are not in the
 * plaintext. `pdfinfo` ships with the same Poppler install as `pdftoppm`.
 */
export async function pdfPageCount(pdf: string): Promise<number | null> {
  try {
    const { stdout } = await execa("pdfinfo", [pdf], { timeout: 30_000 });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export interface BuildOptions {
  /** Directory to compile in. Everything needed must already be here. */
  readonly cwd: string;
  /** Base name of the .tex file, without extension. */
  readonly jobName: string;
}

/**
 * Compile with the classic four-pass sequence.
 *
 * `pdflatex, bibtex, pdflatex, pdflatex` is what resolves citations and
 * cross-references: the first pass emits `.aux`, bibtex turns that into `.bbl`,
 * and the last two settle references and page numbers. `bibtex` failing is not
 * fatal on its own -- a manuscript with no citations has nothing for it to do.
 */
export async function compileLatex(options: BuildOptions): Promise<BuildResult> {
  const { cwd, jobName } = options;
  const env = scrubbedEnv();
  const logs: string[] = [];

  const passes: Array<{ bin: string; args: string[]; fatal: boolean }> = [
    { bin: "pdflatex", args: ["-interaction=nonstopmode", `${jobName}.tex`], fatal: false },
    { bin: "bibtex", args: [jobName], fatal: false },
    { bin: "pdflatex", args: ["-interaction=nonstopmode", `${jobName}.tex`], fatal: false },
    { bin: "pdflatex", args: ["-interaction=nonstopmode", `${jobName}.tex`], fatal: false },
  ];

  for (const pass of passes) {
    try {
      const result = await execa(pass.bin, pass.args, {
        cwd,
        env,
        timeout: COMMAND_TIMEOUT_MS,
        reject: false,
      });
      logs.push(`$ ${pass.bin} ${pass.args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    } catch (error) {
      logs.push(`$ ${pass.bin} ${pass.args.join(" ")}\nFAILED: ${(error as Error).message}`);
    }
  }

  const log = logs.join("\n\n");
  const pdf = join(cwd, `${jobName}.pdf`);
  const produced = existsSync(pdf) && statSync(pdf).size > 0;

  // Diagnose from the FILES, not from stdout.
  //
  // pdflatex overwrites `.log` on every pass, so after the final pass it holds
  // exactly the finished state -- references and citations that legitimately
  // resolve on a later pass are simply absent. Concatenated stdout, by
  // contrast, still carries every pass-1 complaint, which made the extracted
  // error list depend on how far the build got rather than on whether it
  // worked. bibtex's missing-entry warnings live only in `.blg`.
  const parts = [log];
  for (const extension of [".log", ".blg"]) {
    const file = join(cwd, `${jobName}${extension}`);
    if (existsSync(file)) parts.push(readFileSync(file, "utf8"));
  }
  const fullLog = parts.join("\n\n");
  // Errors come from the authoritative files when they exist; stdout is only a
  // fallback for a build that died before writing a log at all.
  const diagnostic = parts.length > 1 ? parts.slice(1).join("\n\n") : log;

  const errors = extractLatexErrors(diagnostic);

  return {
    // TeX can recover from an error and leave a PDF containing visibly broken
    // content. A produced file alone is therefore not a successful build.
    ok: produced && errors.length === 0,
    pdf: produced ? pdf : null,
    pages: produced ? await pdfPageCount(pdf) : null,
    errors,
    unresolvedCitationMarks: produced ? await countUnresolvedCitationMarks(pdf) : 0,
    overfullBoxes: extractOverfullBoxes(diagnostic),
    log: fullLog,
  };
}

/**
 * Copy into the scratch build directory, writable.
 *
 * `copyFileSync` preserves the source mode, and imported template files are
 * mode 0444, so a plain copy makes every staged file read-only and any
 * subsequent overwrite fails with EACCES -- which is how both the refinement
 * stage and the generated-bibliography copy broke. The build directory is
 * scratch; only `source/` and `template/` need to stay locked.
 */
function copyWritable(from: string, to: string): void {
  copyFileSync(from, to);
  chmodSync(to, 0o644);
}

/** Shared by build staging, stale-build checks and portable export. No scripts or run metadata. */
export function isLatexDependency(rel: string): boolean {
  return !rel.split(/[\\/]/).some((part) => part.startsWith(".")) &&
    !/(?:secret|credential|token|auth)(?:[._-]|$)/i.test(rel) &&
    /\.(tex|bib|bbl|sty|cls|bst|bbx|cbx|lbx|clo|def|cfg|fd|ltx|png|jpe?g|pdf|eps|svg|otf|ttf|tfm|pfb|enc|map)$/i.test(rel);
}

export function manuscriptDependencies(workspace: string, texSource: string): string[] {
  const root = paths(workspace).brainManuscript;
  if (realpathSync(root) !== resolve(root)) throw new Error("Refusing symlinked manuscript directory");
  const excluded = new Set([ARTIFACTS.rawDraft, ARTIFACTS.finalTex, ARTIFACTS.finalPdf]
    .map((rel) => relative(root, join(workspace, rel))));
  excluded.add(relative(root, resolve(texSource)));
  return walkFiles(root).filter((rel) => isLatexDependency(rel) && !excluded.has(rel));
}

/** The exact source set, including precedence, used both to stage and to reject stale builds. */
export function latexBuildInputs(workspace: string, texSource: string, jobName = "manuscript"): Map<string, string> {
  const p = paths(workspace);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(jobName)) throw new Error("Unsafe LaTeX job name");
  const dependencies = manuscriptDependencies(workspace, texSource);
  if (realpathSync(p.template) !== resolve(p.template) ||
      !realpathSync(texSource).startsWith(realpathSync(p.brainManuscript) + sep) ||
      !lstatSync(texSource).isFile()) throw new Error("Unsafe LaTeX source/template path");
  const inputs = new Map<string, string>();
  for (const rel of walkFiles(p.template)) {
    if (isLatexDependency(rel) && rel !== "template.tex" && rel !== `${jobName}.pdf` && rel !== `${jobName}.tex`) inputs.set(rel, join(p.template, rel));
  }
  for (const rel of dependencies) {
    if (rel === `${jobName}.tex` || rel === `${jobName}.pdf`) throw new Error(`Reserved build output: ${rel}`);
    inputs.set(rel, join(p.brainManuscript, rel));
  }
  const generatedBib = join(workspace, ARTIFACTS.references);
  if (existsSync(generatedBib)) {
    if (realpathSync(generatedBib) !== resolve(generatedBib) || !lstatSync(generatedBib).isFile()) throw new Error("Unsafe generated bibliography path");
    inputs.set("references.bib", generatedBib);
  }
  inputs.set(`${jobName}.tex`, texSource);
  return new Map([...inputs].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Stage a build directory: the template's support files plus the manuscript.
 *
 * Compiling in a scratch directory rather than in `template/` keeps the
 * digest-locked template pristine, and keeps LaTeX's litter (`.aux`, `.bbl`,
 * `.log`) out of the artifacts a checkpoint records as the manuscript.
 */
export function stageBuildDir(
  workspace: string,
  texSource: string,
  jobName = "manuscript",
): string {
  const p = paths(workspace);
  const buildDir = join(p.brainTmp, "build");
  const inputs = latexBuildInputs(workspace, texSource, jobName);
  if (existsSync(p.brainTmp) && realpathSync(p.brainTmp) !== resolve(p.brainTmp)) {
    throw new Error("Refusing symlinked build scratch directory");
  }

  // Always build from scratch. Two reasons, one of which is a correctness
  // issue rather than hygiene:
  //
  //  * Imported template files are mode 0444, so `copyFileSync` over a
  //    surviving copy from a previous stage fails with EACCES. That is exactly
  //    how the refinement stage died after section_writing had already built.
  //  * A stale `.aux`/`.bbl` from a previous manuscript can let a build resolve
  //    references against the OLD bibliography and report success, which is
  //    worse than failing.
  rmSync(buildDir, { recursive: true, force: true });
  ensureDir(buildDir);

  for (const [rel, from] of inputs) {
    const target = join(buildDir, rel);
    ensureDir(dirname(target));
    copyWritable(from, target);
  }
  writeJsonAtomic(join(buildDir, ".po-inputs.json"), Object.fromEntries([...inputs.keys()]
    .map((rel) => [rel, digestFile(join(buildDir, rel))])));
  return buildDir;
}

/**
 * Render PDF pages to PNG for visual review.
 *
 * Uses Poppler's `pdftoppm`, which is present here, rather than the Python's
 * PyMuPDF + OpenCV path (pdf_utils.py:253-293), which is not.
 */
export async function renderPdfPages(
  pdf: string,
  outDir: string,
  maxPages = 12,
): Promise<string[]> {
  ensureDir(outDir);
  const prefix = join(outDir, "page");
  try {
    await execa(
      "pdftoppm",
      ["-png", "-r", "110", "-f", "1", "-l", String(maxPages), pdf, prefix],
      { timeout: COMMAND_TIMEOUT_MS },
    );
  } catch {
    return [];
  }
  return readdirSync(outDir)
    .filter((name) => name.startsWith("page") && name.endsWith(".png"))
    .sort()
    .map((name) => join(outDir, name));
}
