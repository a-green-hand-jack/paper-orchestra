import { execa } from "execa";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { ARTIFACTS, SOURCE_DIR } from "./paths.js";
import { UserFacingError } from "./errors.js";
import {
  assertInside,
  ensureDir,
  makeReadOnly,
  statKind,
  UnsafePathError,
  walkFiles,
  writeJsonAtomic,
  digestFile,
} from "./files.js";
import { INTERNAL_DIRS, paths } from "./paths.js";
import { authoredFiles, depthOf } from "./salience.js";
import { EXTRACTABLE, FIGURE_DIR_NAMES, extractData, inspectPdf, isManuscriptPath, isSensitive, safeSourcePath } from "./input-extraction.js";
export { isSensitive } from "./input-extraction.js";

export type MaterialRole = "research" | "figure" | "template" | "manuscript" | "sensitive" | "unknown";

/** A neutral document name is unknown, not evidence of a manuscript. PDFs
 * require controller inspection; a research-like filename cannot admit prose. */
export function materialRole(rel: string, body?: string): MaterialRole {
  if (isSensitive(rel)) return "sensitive";
  const ext = extname(rel).toLowerCase();
  const document = /\.(?:pdf|tex|md|txt|rst|org|html?|docx?|odt|rtf|ipynb|json)$/i.test(rel);
  if (!document) return "research";
  if (isManuscriptPath(rel)) return "manuscript";
  if (ext === ".tex" && body !== undefined && /\\documentclass|\\begin\{document\}/.test(body)) {
    const inner = body.includes("\\begin{document}") ? body.slice(body.indexOf("\\begin{document}")) : body;
    const prose = inner.replace(/%.*/g, "").replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, "").replace(/[\s{}\[\]$&_^~#\\]+/g, " ").trim();
    const placeholders = body.match(/(?:abstract|introduction|conclusion|methodology|related work|results|discussion|acknowledgements|contributions) here\.|(?:TODO|write here|placeholder)/gi) ?? [];
    // Sparse structure alone is not evidence of a template. Positive scaffold
    // markers are required once there is more than a few words of prose.
    return prose.length === 0 || (/template|example|sample|skeleton/i.test(rel) && prose.length < 600 && placeholders.length >= 2)
      ? "template" : "manuscript";
  }
  if (body !== undefined) {
    const text = /\.(?:html?|rtf)$/i.test(rel) ? body.replace(/<[^>]*>/g, "\n").replace(/\\[a-z]+\d*\s?/gi, "\n") : body;
    const headings = ["abstract", "introduction", "related work", "methods?", "experiments?|results", "conclusions?", "references"];
    const sections = headings.filter((h) => new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*|\\\\(?:sub)*section\\*?\\{)?(?:[0-9.]+\\s+)?(?:${h})(?:[\\s}:]|$)`, "im").test(text)).length;
    if (sections >= 4 || (/\\begin\{abstract\}/.test(body) && /\\(?:sub)*section\{(?:Introduction|Conclusion)/i.test(body))) return "manuscript";
  }
  const research = /(?:^|[\/_. -])(?:notes?|ideas?|research_overview|results?|measurements?|metrics?|experiments?|logs?|figures?|figs?|plots?|tables?|equations?|derivations?)(?:$|[\/_. -])/i.test(rel);
  if (ext === ".pdf") return "unknown";
  if ([".doc", ".docx", ".odt", ".rtf"].includes(ext)) return research ? "research" : "unknown";
  if (ext === ".tex") {
    if (body === undefined) return "research";
    const support = /(?:^|[\/_. -])(?:preamble|math_commands)(?:$|[\/_. -])/i.test(rel) ||
      (/\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|usepackage)\b/.test(body) && !/\\(?:section|chapter)\b/.test(body));
    const emptyScaffold = body.replace(/%.*/g, "").replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, "").replace(/[\s{}]+/g, "") === "";
    return research || support || emptyScaffold || (/template|example|sample|skeleton/i.test(rel) && body.length < 400 && /here\.|TODO|placeholder/i.test(body)) ? "research" : "manuscript";
  }
  return "research";
}

function roleOfFile(root: string, rel: string): MaterialRole {
  const role = materialRole(rel);
  if (role !== "research") return role;
  if (/\.(?:tex|md|txt|rst|org|html?|rtf)$/i.test(rel)) {
    const abs = safeSourcePath(root, rel);
    const fd = openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      return materialRole(rel, buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"));
    } finally { closeSync(fd); }
  }
  return role;
}

interface InputEntry {
  source: string;
  bytes?: number;
  role: MaterialRole;
  status: "readable" | "unreadable" | "excluded";
  normalized?: string;
  extractor?: string;
  reason?: string;
  /** Safe controller-derived source file, when original bytes were withheld. */
  imported?: string;
  sha256?: string;
  sufficiency?: "partial" | "unresolved" | "not-evidence";
}

function allocateInputPath(preferred: string, reserved: Set<string>): string {
  let candidate = preferred;
  let suffix = 0;
  while ([...reserved].some(rel => rel === candidate || rel.startsWith(candidate + sep) || candidate.startsWith(rel + sep))) {
    candidate = `${preferred.slice(0, -3)}.${++suffix}.md`;
  }
  reserved.add(candidate);
  return candidate;
}

const IMPORT_MANIFEST = "input-import-manifest.json";
const INPUT_MANIFEST = "input-manifest.json";

function manifestPath(workspace: string, name: string): string {
  return join(dirname(paths(workspace).brainInput), name);
}

function readManifest(workspace: string, name: string): InputEntry[] {
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath(workspace, name), "utf8"));
    return Array.isArray(value) ? value as InputEntry[] : [];
  } catch { return []; }
}

/** Unlike the digest walk, report inaccessible directories without aborting a
 * useful import. Sensitive directories are recorded but never traversed. */
function inputCandidates(root: string, note: (rel: string, reason: string) => void): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { note(relative(root, dir) || ".", "unreadable directory"); return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (isSensitive(rel)) { note(rel, "sensitive"); continue; }
      if (entry.isSymbolicLink()) { note(rel, "symlink"); continue; }
      if (entry.isDirectory()) {
        if (INTERNAL_DIRS.includes(entry.name) || isNoiseDir(entry.name)) note(rel, "excluded directory");
        else visit(abs);
      } else if (entry.isFile()) files.push(rel);
      else note(rel, "special file");
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Extensions worth importing. An allowlist rather than a denylist: raw material
 * directories are often working directories with checkpoints, virtualenvs and
 * caches in them, and copying an unknown binary into a digested, read-only tree
 * is never what the user meant.
 */
/**
 * Directories that are never research material.
 *
 * Deliberately NOT added to `INTERNAL_DIRS`, which doubles as the workspace
 * digest exclusion (`paths.ts`): putting `dist` or `build` there would silently
 * drop a legitimately named template subdirectory out of `source_digest`. This
 * list is consulted only by the candidate walk over the user's own directory.
 */
const NOISE_DIRS = new Set([
  ".venv",
  "venv",
  ".virtualenv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".ipynb_checkpoints",
  "site-packages",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".idea",
  ".vscode",
  ".svn",
  ".hg",
  ".gradle",
  ".terraform",
]);

/**
 * A workspace may be created inside the materials directory -- `-o` defaults to
 * `./po-run-<timestamp>` relative to the cwd, which the documented workflow
 * makes the materials directory. `.gitignore` anticipates this; the import walk
 * did not, so a second run imported the first run's workspace as material.
 */
const WORKSPACE_DIR_PREFIX = "po-run-";

export function isNoiseDir(name: string): boolean {
  return NOISE_DIRS.has(name) || name.startsWith(WORKSPACE_DIR_PREFIX);
}

/**
 * One per-file ceiling, for every kind of file.
 *
 * There were two, chosen by whether the extension looked binary -- 2 MiB for
 * text and 64 MiB otherwise. That distinction required classifying the file
 * first, and classifying is what this module is getting out of the business of
 * doing. A 40 MiB CSV of measurements is as legitimate as a 40 MiB figure, and
 * the ceiling's actual job is to keep one pathological file out of a
 * digest-locked tree, which is a question about size alone.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Whole-import ceilings.
 *
 * These are what make the whole-tree `source_digest` defensible once a
 * repository can be the input: the digest set is bounded by construction at
 * import, so `verifyLocks` never faces an unbounded tree on every resume.
 * Exceeding them is an error rather than a truncation, because importing the
 * first N files in sort order would make a run's provenance depend on filename
 * luck.
 */
export const MAX_IMPORT_FILES = 5000;
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/**
 * Whether a file's leading bytes look like text.
 *
 * This is what lets the sniff tier admit `README`, `LICENSE` and `Dockerfile`
 * without maintaining a name list, while still rejecting `.so`, `.pyc`, `.whl`
 * and `.exe` once unknown extensions are no longer refused outright.
 */
export function looksLikeText(path: string): boolean {
  let handle: number | null = null;
  try {
    handle = openSync(path, "r");
    const buffer = Buffer.alloc(8192);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, read);
    if (sample.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return true;
    } catch {
      // A multi-byte codepoint straddling the 8 KiB boundary is not evidence of
      // binary content, so retry without the tail before deciding.
      if (read < buffer.length) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, read - 4));
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

export interface ImportResult {
  readonly files: string[];
  readonly skipped: string[];
  /** Skip counts by reason, so a caller can summarize instead of listing. */
  readonly skippedByReason: Record<string, number>;
  readonly bytes: number;
}

/**
 * Import a directory into the workspace, then lock it. PDF originals are the
 * exception: only checked figure assets or numeric previews enter source/. Unknown
 * PDFs remain at the raw input location, with metadata-only unresolved entries.
 *
 * Unsafe entries are skipped rather than refused: this walk is over the user's
 * own directory, so a symlink here is never copied and therefore never enters
 * the digest set (see `walkFiles`). The digest walk over `source/` keeps the
 * throwing default.
 *
 * Importing nothing is normally an error. An unknown-PDF-only input instead
 * retains its inventory so triage can report insufficient/unresolved evidence.
 */
export interface ImportOptions {
  /**
   * Input-relative paths to leave behind.
   *
   * Used to keep the discovered template out of `source/`. The exclusion is
   * load-bearing rather than tidy: `suppliedBibliography` and
   * `suppliedFiguresDir` decide whether the author handed us a bibliography or
   * figures by searching the material tree, so a venue's stub left among the
   * materials would impersonate the author's own.
   */
  readonly exclude?: ReadonlySet<string>;
}

export function importDirectory(
  from: string,
  to: string,
  options: ImportOptions = {},
): ImportResult {
  const workspace = dirname(resolve(to));
  if (basename(resolve(to)) === SOURCE_DIR && (resolve(from) === workspace || resolve(from).startsWith(workspace + sep))) {
    throw new UnsafePathError("raw inputs must be outside the writer workspace so quarantined originals are not accessible there");
  }
  if (!existsSync(from)) {
    throw new UnsafePathError(`input directory does not exist: ${from}`);
  }
  if (statKind(from) !== "dir") {
    throw new UnsafePathError(`input is not a directory: ${from}`);
  }

  const skipped: string[] = [];
  const skippedEntries: { source: string; reason: string }[] = [];
  const skippedByReason: Record<string, number> = {};
  const note = (rel: string, reason: string): void => {
    skipped.push(`${rel} (${reason})`);
    skippedEntries.push({ source: rel, reason });
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  };

  const candidates = inputCandidates(from, note);
  const reserved = new Set(candidates);
  const pdfEntries = new Map<string, InputEntry>();
  const pdfPreviews = new Map<string, string>();
  const inspectionStart = performance.now();
  let pdfInspections = 0;

  const keep: string[] = [];
  let bytes = 0;
  let hasUnknownDocument = false;

  for (const rel of candidates) {
    if (options.exclude?.has(rel)) {
      note(rel, "belongs to the template");
      continue;
    }
    if (isSensitive(rel)) {
      note(rel, "sensitive");
      continue;
    }

    let size: number;
    try {
      const abs = safeSourcePath(from, rel);
      size = statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        note(rel, `too large (${size} bytes, cap ${MAX_FILE_BYTES})`);
        continue;
      }
      const role = roleOfFile(from, rel);
      if (extname(rel).toLowerCase() === ".pdf" && role === "unknown") {
        const inspected: ReturnType<typeof inspectPdf> = pdfInspections >= 32 || performance.now() - inspectionStart > 60000
          ? { role: "unknown" as const, reason: "PDF inspection budget exhausted (32 documents or 60 seconds); evidence unresolved" }
          : inspectPdf(from, rel);
        pdfInspections++;
        const figure = inspected.role === "figure";
        const entry: InputEntry = { source: rel, bytes: size, role: inspected.role,
          status: figure || inspected.preview ? "readable" : "excluded", reason: inspected.reason,
          extractor: figure ? "pdf-figure-v1" : "pdf-numeric-v1", sha256: inspected.sha256,
          sufficiency: inspected.role === "manuscript" ? "not-evidence" : figure || inspected.preview ? "partial" : "unresolved" };
        pdfEntries.set(rel, entry);
        if (!figure && !inspected.preview) { note(rel, `${inspected.role}: ${inspected.reason}`); continue; }
        entry.imported = figure ? rel : allocateInputPath(`${rel}.text.md`, reserved);
        if (inspected.preview) pdfPreviews.set(rel, inspected.preview);
      } else if (role === "manuscript" || role === "sensitive" || role === "unknown" || (role === "template" && basename(to) !== "template")) {
        if (role === "unknown") hasUnknownDocument = true;
        note(rel, role);
        continue;
      }
      // Probe readability without pulling any content into an error message.
      const fd = openSync(abs, "r");
      closeSync(fd);
    } catch { note(rel, "unreadable or unsafe source"); continue; }
    if (size > MAX_FILE_BYTES) {
      note(rel, `too large (${size} bytes, cap ${MAX_FILE_BYTES})`);
      continue;
    }

    keep.push(rel);
    bytes += size;

    if (keep.length > MAX_IMPORT_FILES) {
      throw new UserFacingError(
        `refusing to import more than ${MAX_IMPORT_FILES} files from ${from}. ` +
          `${largestDirectories(from, candidates)} ` +
          "Point --output at a narrower directory, or remove what is not research material.",
      );
    }
    if (bytes > MAX_IMPORT_BYTES) {
      throw new UserFacingError(
        `refusing to import more than ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MiB from ` +
          `${from}. ${largestDirectories(from, candidates)} ` +
          "Point the materials argument at a narrower directory.",
      );
    }
  }

  if (keep.length === 0 && !hasUnknownDocument && ![...pdfEntries.values()].some(entry => entry.role === "unknown")) {
    const reasons = Object.entries(skippedByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    throw new UserFacingError(
      `imported no files from ${from}. ` +
        (reasons ? `Everything was skipped: ${reasons}. ` : "The directory holds no files. ") +
        "Point the materials argument at the directory holding your idea, notes and results.",
    );
  }

  ensureDir(to);
  const written: string[] = [];
  for (const rel of keep) {
    const entry = pdfEntries.get(rel);
    const destination = entry?.imported ?? rel;
    const target = assertInside(to, destination);
    ensureDir(dirname(target));
    try {
      const preview = pdfPreviews.get(rel);
      if (preview !== undefined) writeFileSync(target, preview, { flag: "wx" });
      else copyFileSync(safeSourcePath(from, rel), target);
      if (entry?.role === "figure" && digestFile(target) !== entry.sha256) {
        unlinkSync(target);
        throw new UnsafePathError("figure changed after inspection");
      }
      written.push(destination);
    } catch {
      note(rel, "unreadable or unsafe source during copy");
      if (entry) { entry.status = "unreadable"; entry.sufficiency = "unresolved"; entry.reason = "could not write safe PDF preview"; }
    }
  }
  if (written.length === 0 && keep.length > 0) throw new UserFacingError("no readable material could be copied");
  bytes = written.reduce((sum, rel) => sum + statSync(assertInside(to, rel)).size, 0);
  makeReadOnly(to, written);
  if (basename(resolve(to)) === SOURCE_DIR) {
    const exclusions: InputEntry[] = skippedEntries.map(({ source, reason }): InputEntry => {
      return { source, status: reason.startsWith("unreadable") ? "unreadable" : "excluded", reason,
        role: reason === "sensitive" ? "sensitive" : reason === "manuscript" ? "manuscript" : reason === "unknown" ? "unknown" : reason.includes("template") ? "template" : "research",
        ...(reason === "manuscript" ? { sufficiency: "not-evidence" } : {}),
        ...(reason === "unknown" ? { sufficiency: "unresolved", reason: "unknown document role; original withheld, evidence unresolved" } : {}) };
    }).filter(entry => !pdfEntries.has(entry.source));
    writeJsonAtomic(manifestPath(dirname(resolve(to)), IMPORT_MANIFEST), [...exclusions, ...pdfEntries.values()]);
  }

  return { files: written, skipped, skippedByReason, bytes };
}

/** Name the directories contributing most files, so a cap error is actionable. */
/**
 * Copy an explicit set of files into the workspace `template/` tree.
 *
 * Separate from `importDirectory` because the input is a mapping rather than a
 * directory: the caller has already decided which files belong to the template
 * and where each one goes, and several of them come from directories that are
 * not the template's. The safety treatment is the same -- `assertInside` on
 * every destination, then mode 0444 -- because the result is digest-locked and
 * read-only exactly like an imported tree.
 *
 * A basename collision is refused rather than resolved. Two claimed files
 * landing on one destination would mean one silently wins, and which one won
 * would decide how the paper compiles.
 */
export function importTemplateFiles(
  from: string,
  to: string,
  layout: ReadonlyMap<string, string>,
): ImportResult {
  const root = resolve(from);
  const taken = new Map<string, string>();
  for (const [rel, destination] of layout) {
    safeSourcePath(root, rel);
    const role = roleOfFile(root, rel);
    if (role === "sensitive" || role === "manuscript" || role === "unknown") {
      throw new UnsafePathError(`refusing ${role} as template: ${rel}`);
    }
    const owner = taken.get(destination);
    if (owner) {
      throw new UserFacingError(
        `the template's ${rel} and ${owner} would both be installed as ` +
          `template/${destination}. Rename one, or pass --template <dir> to supply the ` +
          "template directly.",
      );
    }
    taken.set(destination, rel);
  }

  ensureDir(to);
  const written: string[] = [];
  let bytes = 0;
  for (const [rel, destination] of layout) {
    const target = assertInside(to, destination);
    ensureDir(dirname(target));
    copyFileSync(safeSourcePath(root, rel), target);
    written.push(destination);
    try {
      bytes += statSync(target).size;
    } catch {
      // A file we just copied; a stat failure is not worth failing the import.
    }
  }
  makeReadOnly(to, written);
  return { files: written.sort(), skipped: [], skippedByReason: {}, bytes };
}

function largestDirectories(from: string, candidates: readonly string[]): string {
  const counts: Record<string, number> = {};
  for (const rel of candidates) {
    const top = rel.split("/")[0] ?? rel;
    counts[top] = (counts[top] ?? 0) + 1;
  }
  const worst = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([dir, count]) => `${dir}/ (${count})`)
    .join(", ");
  return worst ? `Largest contributors: ${worst}.` : "";
}

/** Archive kinds we can inspect before extraction. */
type ArchiveKind = "zip" | "tar";

function archiveKind(path: string): ArchiveKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar";
  return null;
}

/**
 * List an archive's members WITHOUT extracting, so a member that would escape
 * the destination is rejected before any bytes are written. Extracting first
 * and cleaning up afterwards is not equivalent: the escape has already
 * happened by then.
 */
export async function listArchive(path: string): Promise<string[]> {
  const kind = archiveKind(path);
  if (!kind) throw new UnsafePathError(`unsupported archive: ${path}`);
  const { stdout } =
    kind === "zip"
      ? await execa("unzip", ["-Z1", path])
      : await execa("tar", ["-tf", path]);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function assertArchiveSafe(path: string, destination: string): Promise<string[]> {
  const members = await listArchive(path);
  for (const member of members) {
    if (member.startsWith("/") || member.split("/").includes("..")) {
      throw new UnsafePathError(`archive path escapes workspace: ${member}`);
    }
    assertInside(destination, member);
  }
  return members;
}

/** Emit only a controller-approved numeric preview, never PDF prose. The
 * historical name is retained; .pdf.text.md is now a partial data view. */
export async function convertPdfToText(
  pdf: string,
  outDir: string,
  relPath?: string,
): Promise<string> {
  const rel = relPath ?? basename(pdf);
  const source = safeSourcePath(dirname(resolve(pdf)), basename(pdf));
  const target = assertInside(outDir, `${rel}.text.md`);
  if (["manuscript", "sensitive"].includes(materialRole(rel))) throw new UnsafePathError(`excluded PDF role: ${rel}`);
  ensureDir(dirname(target));
  if (existsSync(target)) throw new UnsafePathError(`refusing to overwrite PDF text: ${rel}`);
  if (materialRole(basename(source)) === "manuscript") throw new UnsafePathError("excluded PDF source role");
  const inspected = inspectPdf(dirname(source), basename(source));
  if (!inspected.preview) throw new UnsafePathError(`${inspected.role}: ${inspected.reason}`);
  writeFileSync(target, inspected.preview, { flag: "wx" });
  return target;
}

export interface BrainInputResult {
  readonly files: string[];
  /** Files that could not be normalized, with the reason. */
  readonly skipped: string[];
  /**
   * Imported files with no readable view, plus unknown/quarantined original
   * documents. These are evidence gaps, not evidence that a paper is sufficient.
   */
  readonly unreadable: string[];
  readonly manifest: string;
}

/**
 * Normalize imported material into `.brain/input/`, which is what the agent
 * reads. `source/` stays pristine and read-only; anything derived lands here so
 * the lock over `source/` is never disturbed by our own preprocessing.
 *
 * PDF originals must pass through importDirectory's controller inspection;
 * only checked figure assets or numeric previews are imported. Refuse other raw PDFs in source/
 * rather than silently leave potentially finished prose accessible to writers.
 */
export async function prepareBrainInput(workspace: string): Promise<BrainInputResult> {
  const p = paths(workspace);
  ensureDir(p.brainInput);
  const produced: string[] = [];
  const skipped: string[] = [];
  const entries: InputEntry[] = readManifest(workspace, IMPORT_MANIFEST);
  const unreadable: string[] = entries.filter(entry => entry.role === "unknown" || entry.status === "unreadable").map(entry => entry.source);
  const sources = walkFiles(p.source);
  if (sources.some(rel => extname(rel).toLowerCase() === ".pdf" && !entries.some(entry =>
    entry.role === "figure" && entry.imported === rel && entry.source === rel &&
    entry.sha256 === digestFile(safeSourcePath(p.source, rel)) && inspectPdf(p.source, rel).role === "figure"))) {
    throw new UnsafePathError("raw PDFs in source/ bypass controller quarantine; reimport the raw directory into a new workspace with importDirectory");
  }
  const reserved = new Set([...sources, ...walkFiles(p.brainInput)]);
  const allocate = (preferred: string): string => allocateInputPath(preferred, reserved);

  for (const rel of sources) {
    const abs = safeSourcePath(p.source, rel);
    const extension = extname(rel).toLowerCase();
    const importedEntry = entries.find(entry => entry.imported === rel);
    const role = importedEntry?.role ?? roleOfFile(p.source, rel);
    const entry: InputEntry = importedEntry ?? { source: rel, bytes: statSync(abs).size, role, status: "unreadable" };
    if (!importedEntry) entries.push(entry);
    if (role === "figure") {
      const target = assertInside(p.brainInput, allocate(`${rel}.asset.md`));
      ensureDir(dirname(target));
      writeFileSync(target, `# Supplied figure asset\n\nSource: ${JSON.stringify(rel)}\n` +
        `Publishing path: ${JSON.stringify(join(SOURCE_DIR, rel))}\nSHA256: ${entry.sha256}\n\n` +
        "Controller-checked single-page vector figure. Original retained for publishing; no PDF prose mirrored.\n" +
        "Figure availability is not evidence sufficiency. Use independent raw records for measurements and interpretation.\n", { flag: "wx" });
      produced.push(target);
      entry.status = "readable";
      entry.normalized = relative(workspace, target);
      continue;
    }
    if (role !== "research") {
      entry.status = "excluded";
      entry.reason = role;
      skipped.push(`${rel} (${role})`);
      continue;
    }

    if (EXTRACTABLE.has(extension)) {
      try {
        const text = await extractData(p.source, rel);
        const target = assertInside(p.brainInput, allocate(`${rel}.summary.md`));
        ensureDir(dirname(target));
        writeFileSync(target, text, { flag: "wx" });
        produced.push(target);
        entry.status = "readable";
        entry.normalized = relative(workspace, target);
        entry.extractor = "python-data-v1 (bounded sample)";
      } catch {
        entry.reason = "data extraction failed, dependency unavailable, or exceeded limits";
        skipped.push(`${rel} (${entry.reason})`);
        unreadable.push(rel);
      }
      continue;
    }
    // Mirrored only if the bytes really are text. This is the one place a
    // readability judgement belongs, it is made from content rather than from a
    // name, and being left out here is not being hidden: `materialsInventory`
    // lists every file in `source/` and marks the ones it could not mirror, so
    // the agent knows a `runs.npy` exists and that it cannot read it.
    if (!looksLikeText(abs)) {
      unreadable.push(rel);
      entry.reason = "no supported text extractor";
      continue;
    }

    const target = assertInside(p.brainInput, rel);
    ensureDir(dirname(target));
    copyFileSync(abs, target);
    produced.push(target);
    entry.status = "readable";
    entry.normalized = relative(workspace, target);
    entry.extractor ??= "text mirror";
  }
  const manifest = manifestPath(workspace, INPUT_MANIFEST);
  writeJsonAtomic(manifest, entries);
  return { files: produced.map((path) => relative(workspace, path)), skipped, unreadable, manifest: relative(workspace, manifest) };
}

/** Public name for controller-owned input normalization. */
export const normalizeInput = prepareBrainInput;

/** Extensions a supplied figure can arrive as. */
const FIGURE_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

/**
 * Directory names an author uses for the figures they drew themselves.
 *
 * A name list rather than "any directory holding images", because a repository
 * is full of images that are not this paper's figures -- a README banner, a
 * screenshot in a docs folder, an icon. Publishing those would put them in the
 * manuscript: `figureCoverage` requires every figure in `info.json` to be
 * `\includegraphics`'d, so a stray logo becomes a figure the writer is
 * REQUIRED to place.
 */

/**
 * Where the author put the figures they drew, workspace-relative, or null.
 *
 * SEARCHED, for the same reason `suppliedBibliography` is: reading exactly
 * `source/figures/` finds nothing when the input is a repository whose
 * materials sit one level down, and "no figures supplied" is indistinguishable
 * from "the author drew none". Seven figures then go unpublished and
 * `figureCoverage` passes trivially over the empty set.
 *
 * Vendored directories are excluded by `salience.ts`. That matters here as much
 * as it does for bibliographies: one corpus input's bundled tool ships both
 * `assets/overview.png` and `frontend/examples/cvpr_example_figure.png`.
 */
export function suppliedFiguresDir(workspace: string): string | null {
  const root = paths(workspace).source;
  const admitted = readManifest(workspace, IMPORT_MANIFEST);
  const byDir = new Map<string, number>();
  for (const rel of authoredFiles(root)) {
    if (!FIGURE_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    if (extname(rel).toLowerCase() === ".pdf" && !admitted.some(entry => entry.role === "figure" && entry.imported === rel &&
      entry.sha256 === digestFile(safeSourcePath(root, rel)))) continue;
    const dir = dirname(rel);
    const base = dir.split(sep).pop()?.toLowerCase();
    if (base === undefined || !FIGURE_DIR_NAMES.has(base)) continue;
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  if (byDir.size === 0) return null;
  const best = [...byDir.keys()].sort(
    (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
  )[0] as string;
  return join(SOURCE_DIR, best);
}

/** Read-whole size hints only. Small inputs still require triage/sufficiency
 * assessment; a tiny preview or quarantined document is not complete evidence. */
export const READ_WHOLE_MAX_BYTES = 64 * 1024;
export const READ_WHOLE_MAX_FILES = 25;

/** Whether the complete readable view fits the size budget. This is not an
 * authorization to bypass triage or a trusted evidence-sufficiency verdict. */
export function materialsFitWhole(workspace: string): boolean {
  const p = paths(workspace);
  const manifest = readManifest(workspace, INPUT_MANIFEST);
  const sources = walkFiles(p.source, { onUnsafe: "skip" });
  // A tiny readable subset does not mean the entire import can be read whole.
  if (sources.some((source) => !manifest.some((entry) => entry.source === source && entry.status === "readable" &&
    entry.extractor === "text mirror" && entry.normalized && existsSync(assertInside(workspace, entry.normalized))))) return false;
  if (manifest.some((entry) => entry.role === "unknown" || entry.sufficiency === "partial" || entry.sufficiency === "unresolved" ||
    entry.status === "unreadable" || entry.reason?.includes("unreadable"))) return false;
  const files = walkFiles(p.brainInput, { onUnsafe: "skip" });
  if (files.length === 0 || files.length > READ_WHOLE_MAX_FILES) return false;
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += statSync(join(p.brainInput, rel)).size;
    } catch {
      return false;
    }
    if (bytes > READ_WHOLE_MAX_BYTES) return false;
  }
  return true;
}

/**
 * A listing of the normalized materials, for the triage prompt.
 *
 * Given to the model rather than left to be discovered, so it starts with a map
 * instead of spending a turn globbing, and so `materials_considered` in
 * `materials.json` has something to be checked against. Sizes are included
 * because they are the cheapest signal about which files carry substance.
 *
 * Bounded: a repository can hold thousands of files, and the inventory must not
 * crowd out the materials themselves. Directories are summarized once the list
 * would grow past the cap.
 */
export function materialsInventory(workspace: string, maxEntries = 200): string {
  const p = paths(workspace);
  const manifest = readManifest(workspace, INPUT_MANIFEST);
  if (manifest.length > 0) {
    const counts = { readable: 0, unreadable: 0, excluded: 0 };
    for (const entry of manifest) counts[entry.status]++;
    const cap = Math.max(1, Math.min(1000, Math.floor(maxEntries)));
    return [
      `Input inventory: ${counts.readable} readable, ${counts.unreadable} unreadable, ${counts.excluded} excluded.`,
      `Full provenance: ${relative(workspace, manifestPath(workspace, INPUT_MANIFEST))}. Excluded manuscripts must not be read.`,
      "Unknown documents are quarantined outside the writer workspace, not established manuscripts. Do not open their originals; record their potential evidence as unresolved.",
      "Extracted summaries are partial evidence, not complete datasets or proof of sufficiency. Missing labels/context must be resolved from independent raw records; never infer results.",
      ...manifest.slice(0, cap).map((entry) => `  ${JSON.stringify(entry.source)} [${entry.role}; ${entry.status}]` +
        (entry.bytes === undefined ? "" : ` (${entry.bytes} bytes)`) +
        (entry.sufficiency ? ` [sufficiency: ${entry.sufficiency}]` : "") +
        (entry.normalized ? ` -> ${JSON.stringify(entry.normalized)} (${entry.extractor})` : `: ${entry.reason ?? "no readable copy"}`)),
      ...(manifest.length > cap ? [`  ... ${manifest.length - cap} more entries in the manifest.`] : []),
    ].join("\n");
  }

  // Walked over `source/`, not over the mirrored tree. `source/` is what the
  // author gave us; `.brain/input/` is what happens to be readable. Listing
  // only the latter told the agent that the unreadable files did not exist,
  // which is the one thing an inventory must never do -- a `runs.npy` holding
  // the results then goes unmentioned rather than being reported as a gap.
  const mirrored = new Set(walkFiles(p.brainInput, { onUnsafe: "skip" }));
  const readable = (rel: string): boolean => {
    if (mirrored.has(rel)) return true;
    // A PDF is mirrored as markdown beside its own path.
    return extname(rel).toLowerCase() === ".pdf" && mirrored.has(`${rel}.text.md`);
  };

  const files = walkFiles(p.source, { onUnsafe: "skip" }).map((rel) => ({
    rel,
    bytes: statSync(join(p.source, rel)).size,
    readable: readable(rel),
  }));

  if (files.length === 0) return "(no imported material found)";

  const unreadable = files.filter((f) => !f.readable).length;
  const note = (f: { rel: string; bytes: number; readable: boolean }): string =>
    `  ${f.rel}  (${f.bytes} bytes${f.readable ? "" : ", binary -- no text copy"})`;

  const header =
    `${files.length} file(s) under source/, mirrored for reading under .brain/input/` +
    (unreadable > 0
      ? `. ${unreadable} of them are not text, so no readable copy exists -- expected for ` +
        "images and data blobs, and not a problem by itself. If one of them holds something " +
        "the paper needs and you cannot read it, say so in `unresolved` rather than guessing."
      : ".");

  if (files.length <= maxEntries) {
    return [header, "", ...files.map(note)].join("\n");
  }

  const byDir = new Map<string, { count: number; bytes: number }>();
  for (const f of files) {
    const dir = f.rel.includes(sep) ? f.rel.slice(0, f.rel.lastIndexOf(sep)) : ".";
    const entry = byDir.get(dir) ?? { count: 0, bytes: 0 };
    byDir.set(dir, { count: entry.count + 1, bytes: entry.bytes + f.bytes });
  }
  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 40);
  return [
    `${header} Too many to list individually. Directory summary:`,
    "",
    ...[...byDir.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([dir, e]) => `  ${dir}/  ${e.count} file(s), ${e.bytes} bytes`),
    "",
    "Largest files:",
    "",
    ...largest.map(note),
    "",
    "Use glob and read to explore the rest.",
  ].join("\n");
}

/**
 * A bounded sample of a raw materials directory, for the template selector.
 *
 * The selector only has to judge the paper's topic, which does not require
 * structured documents -- so when the two named documents are absent it reads
 * a sample of whatever is there instead of failing. Ranked, because the budget
 * buys only a few files and which ones matter: prose over code, shallow over
 * deep, and names that announce their content over names that do not.
 *
 * Runs the same widened candidate walk as `importDirectory` (noise directories
 * skipped, symlinks skipped, binaries excluded) so it cannot read something the
 * import itself would refuse.
 */
export function materialSurvey(rawMaterials: string, budgetChars: number): string {
  const root = resolve(rawMaterials);
  const candidates = inputCandidates(root, () => {}).filter((rel) => {
    // This survey is quoted into a prompt, so it wants text and only text --
    // decided by reading the bytes, which is also the only test that works for
    // a format nobody listed.
    if (isSensitive(rel)) return false;
    try {
      const abs = safeSourcePath(root, rel);
      if (statSync(abs).size > MAX_FILE_BYTES) return false;
      if (roleOfFile(root, rel) !== "research") return false;
      return looksLikeText(abs);
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) return "(no readable material found)";

  const INTERESTING = /idea|log|result|readme|note|experiment|abstract|paper|overview|report/i;
  const PROSE = new Set([".md", ".txt", ".rst", ".org", ".tex"]);
  const ranked = [...candidates].sort((a, b) => score(b) - score(a));

  function score(rel: string): number {
    let value = 0;
    if (PROSE.has(extname(rel).toLowerCase())) value += 4;
    if (INTERESTING.test(basename(rel))) value += 3;
    value -= rel.split(sep).length - 1;
    return value;
  }

  const take = Math.min(ranked.length, 12);
  const perFile = Math.max(400, Math.floor(budgetChars / take));
  const blocks: string[] = [];
  let used = 0;
  for (const rel of ranked) {
    if (used >= budgetChars) break;
    let body: string;
    try {
      body = readFileSync(safeSourcePath(root, rel), "utf8").slice(0, perFile);
    } catch {
      continue;
    }
    const block = `<file path="${rel}">\n${body}\n</file>`;
    used += block.length;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}
