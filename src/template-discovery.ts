import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { UserFacingError } from "./errors.js";
import { walkFiles } from "./files.js";
import { isNoiseDir } from "./input.js";
// The author/vendor boundary lives in one place. Template discovery needs the
// same judgement the bibliography and figure searches need, and for the same
// reason: a vendored dependency can contain a complete paper, a bibliography,
// and a directory of figures. Two copies of this rule would drift.
import { depthOf, underForeignDir, underNestedPackage } from "./salience.js";
import { INTERNAL_DIRS } from "./paths.js";

/**
 * Find the LaTeX template inside whatever the user handed us.
 *
 * PaperOrchestra takes ONE input. A template is not a second input the user
 * must shape for us -- it is something that may or may not be in there, like a
 * bibliography or a figure, and finding it is our job. When there is none, a
 * bundled venue is used instead.
 *
 * Deliberately deterministic: no model call, no network. That is not a
 * simplification, it is a requirement. `prepareWorkspace` computes the digest
 * locks immediately after import, so anything discovered has to be on disk
 * before that line or it sits outside the lock the run's provenance rests on.
 * A model stage runs long after prepare, which is the same reason the triage
 * stage is a stage and not a prepare-time pre-flight.
 *
 * Measured against the 273 tasks of `Jack-Jieke-Wu/Paper-Writing-Exam`, whose
 * inputs use three different layouts. Every heuristic below is there because
 * something in that corpus needed it, and the numbers are quoted so a future
 * reader can tell a measurement from a guess.
 */

/** Extensions that belong to a LaTeX template rather than to research material. */
const TEMPLATE_EXTENSIONS = new Set([
  ".tex", ".sty", ".cls", ".bst", ".bib", ".clo", ".def", ".cfg", ".ldf",
]);

/** Files a venue kit ships that are not LaTeX but are still the template's. */
const TEMPLATE_NAMES = new Set(["guidelines.md", "template-metadata.json"]);

/** Extensions a LaTeX dependency can arrive as, keyed by how it is requested. */
const SUPPORT_EXTENSION_FOR = {
  documentclass: ".cls",
  usepackage: ".sty",
  bibliographystyle: ".bst",
} as const;

/** Beyond this the two leading candidates are too close to choose between. */
const DECISIVE_MARGIN = 2;

export interface TemplateCandidate {
  /** Path relative to the input root. */
  readonly path: string;
  readonly score: number;
  /** Prose characters per section heading; low means "waiting to be filled". */
  readonly proseDensity: number;
}

export interface TemplateDiscovery {
  /** The main file, relative to the input root. */
  readonly main: string;
  /**
   * Every input-relative path that belongs to the template. These are imported
   * into `template/` and EXCLUDED from `source/`.
   *
   * The exclusion is the point, not an optimization. Several routing decisions
   * read the material tree by filesystem convention -- `suppliedBibliography`
   * searches it for a `.bib`, `suppliedFiguresDir` for a figures directory --
   * so a venue's stub bibliography or example figure left among the materials
   * would impersonate the author's own. A stub bibliography reaching the
   * material tree makes the run skip paid retrieval and cite the venue's
   * example entries, with no error anywhere.
   */
  readonly templateFiles: readonly string[];
  /** Ranked candidates, best first, for reporting. */
  readonly candidates: readonly TemplateCandidate[];
  /** True when the main file sat in a directory holding nothing but a template. */
  readonly dedicatedDirectory: boolean;
}

/**
 * Is this `.tex` a document in its own right, or a fragment meant to be
 * `\input` by one?
 *
 * Both markers, not either: across the corpus's 750 `.tex` files this split
 * 274 main files from 476 fragments with **no file carrying only one of the
 * two**. Table and preamble fragments have neither.
 */
function isMainDocument(body: string): boolean {
  return body.includes("\\documentclass") && body.includes("\\begin{document}");
}

/**
 * Prose characters per section heading.
 *
 * The one genuinely ambiguous input in the corpus has two main documents whose
 * section COUNTS are identical (21 and 21), so counting structure cannot
 * separate them -- and the template waiting to be filled is the SMALLER file,
 * so preferring the larger one picks the wrong file every time. What separates
 * them is how much prose sits between the headings: 3 characters per section
 * in the template, 1158 in the finished paper that happened to be vendored in
 * the same tree.
 *
 * Used as one ranking signal and never as a threshold: the corpus contains
 * exactly one finished paper, so a cutoff calibrated on it would be a cutoff
 * calibrated on a single sample.
 */
export function proseDensity(body: string): number {
  const at = body.indexOf("\\begin{document}");
  const inner = at >= 0 ? body.slice(at) : body;
  const sections = inner.match(/\\(?:sub)*section\*?\{[^}]*\}/g) ?? [];
  const prose = inner
    .replace(/%.*/g, "")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, "")
    .replace(/[\s{}[\]$&_^~#\\]+/g, " ")
    .trim();
  return prose.length / Math.max(sections.length, 1);
}

/**
 * Rank a main-document candidate.
 *
 * Extends the scorer `materialSurvey` already uses (prose extension, telling
 * basename, one point off per directory level) rather than inventing a second
 * ranking vocabulary for the same kind of question.
 */
function scoreCandidate(root: string, rel: string, density: number): number {
  let value = 0;
  // A paper in `code/` or `vendor/` is a dependency's paper, not this one's.
  if (underForeignDir(rel)) value -= 8;
  // Likewise for anything inside a package vendored into the input.
  if (underNestedPackage(root, rel)) value -= 8;
  // Shallow beats deep: a template the author means for us sits where they
  // would look for it, not four directories down.
  value -= depthOf(rel);
  if (/template|main|paper|manuscript|conference/i.test(basename(rel, ".tex"))) value += 3;
  // Emptier beats fuller. Bounded so it ranks without deciding on its own.
  if (density < 100) value += 4;
  else if (density < 400) value += 1;
  else value -= 4;
  return value;
}

/** Files `\input` or `\include`d by a template, resolved within the input. */
function referencedFragments(root: string, main: string): string[] {
  const found = new Set<string>();
  const queue = [main];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let body: string;
    try {
      body = readFileSync(join(root, current), "utf8");
    } catch {
      continue;
    }
    for (const match of body.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
      const raw = (match[1] ?? "").trim();
      if (!raw || raw.startsWith("/") || raw.includes("..")) continue;
      const withExt = extname(raw) ? raw : `${raw}.tex`;
      const rel = join(dirname(current), withExt);
      if (found.has(rel) || !existsSync(join(root, rel))) continue;
      found.add(rel);
      queue.push(rel);
    }
  }
  return [...found];
}

function isTemplateFile(rel: string): boolean {
  return (
    TEMPLATE_EXTENSIONS.has(extname(rel).toLowerCase()) ||
    TEMPLATE_NAMES.has(basename(rel).toLowerCase())
  );
}

/**
 * Does the main file sit in a directory holding nothing but a template?
 *
 * This decides whether the directory's `references.bib` is the venue's stub or
 * the author's library, and getting it wrong is expensive in both directions.
 * Measured across the corpus, the two layouts separate completely: 200 inputs
 * keep the template in a `conference_template/` directory containing only
 * LaTeX plus `guidelines.md`, while 73 leave `template.tex` beside
 * `research_overview.md`, `code/` and a 189 KB bibliography the author wrote.
 *
 * So: claim the whole directory only when the author gave the template one of
 * its own. Otherwise claim the main file and its dependencies, and leave
 * everything else where it is.
 */
function isDedicatedDirectory(root: string, main: string): boolean {
  const dir = join(root, dirname(main));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const abs = join(dir, entry);
    try {
      // A subdirectory of research material means this is not a template dir.
      if (statSync(abs).isDirectory()) return false;
    } catch {
      return false;
    }
    return isTemplateFile(entry);
  });
}

/**
 * The dependencies the template actually asks for, found anywhere in the input.
 *
 * Names come from the template's own `\documentclass`, `\usepackage` and
 * `\bibliographystyle`, and only files matching those names are claimed.
 * Taking every `.sty` in the tree instead was the obvious first attempt and it
 * is wrong in both directions:
 *
 *  * It claims style files belonging to something else. One corpus input
 *    vendors a whole paper-writing tool whose own venue templates ship six
 *    `.sty`/`.bst` files, including a `natbib.sty` that would then sit in the
 *    build directory and could shadow the real one.
 *  * It reads as though a dependency must live in a blessed location, which
 *    hides the case that made this worth doing: one input's `\documentclass`
 *    resolves to `code/tex/oup-authoring-template.cls`, buried inside a
 *    vendored source tree. Searching by name finds it; searching by location
 *    never would.
 *
 * Looking anywhere is what a single input buys. 73 of the corpus's inputs put
 * `neurips_2025.sty`, `acl.sty` or `natbib.sty` in a `texmf/` directory beside
 * the materials rather than next to the template -- with two separate inputs
 * the user had to merge those trees by hand.
 *
 * A name that resolves to nothing is normal and not an error: most
 * `\usepackage` targets live in the TeX installation, not in the paper.
 */
function supportFilesFor(
  root: string,
  sources: readonly string[],
  all: readonly string[],
): string[] {
  const wanted = new Map<string, string>();
  for (const rel of sources) {
    let body: string;
    try {
      body = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const [command, extension] of Object.entries(SUPPORT_EXTENSION_FOR)) {
      const pattern = new RegExp(`\\\\${command}\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]+)\\}`, "g");
      for (const match of body.matchAll(pattern)) {
        for (const name of (match[1] ?? "").split(",")) {
          const trimmed = name.trim();
          if (trimmed) wanted.set(`${trimmed}${extension}`.toLowerCase(), rel);
        }
      }
    }
  }

  const claimed: string[] = [];
  for (const [filename, requestedBy] of wanted) {
    const matches = all.filter((rel) => basename(rel).toLowerCase() === filename);
    if (matches.length === 0) continue;
    // Several files can share a name -- a vendored copy beside the real one.
    // Prefer the one nearest whatever asked for it.
    const home = dirname(requestedBy);
    matches.sort((a, b) => proximity(home, a) - proximity(home, b) || a.localeCompare(b));
    claimed.push(matches[0] as string);
  }
  return claimed;
}

/** Directory distance from `home` to the file at `rel`; lower is nearer. */
function proximity(home: string, rel: string): number {
  const a = home.split(sep).filter(Boolean);
  const b = dirname(rel).split(sep).filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return a.length - shared + (b.length - shared);
}

/**
 * Everything belonging to the discovered template.
 */
function attribute(root: string, main: string, all: readonly string[]): string[] {
  const fragments = referencedFragments(root, main);
  const claimed = new Set<string>([main, ...fragments]);

  for (const rel of supportFilesFor(root, [main, ...fragments], all)) claimed.add(rel);

  if (isDedicatedDirectory(root, main)) {
    const dir = dirname(main);
    for (const rel of all) {
      if (dirname(rel) === dir) claimed.add(rel);
    }
  }

  return [...claimed].sort();
}

/**
 * Find the template in an input directory, or null when there is none.
 *
 * Never throws for "no template" -- that is an ordinary outcome that routes to
 * a bundled venue. It throws only when the input offers several equally
 * plausible templates, because silently picking one would decide the paper's
 * format by a scoring tie.
 */
export function discoverTemplate(input: string): TemplateDiscovery | null {
  const root = resolve(input);
  const all = walkFiles(root, {
    skipDirs: INTERNAL_DIRS,
    skipDir: isNoiseDir,
    onUnsafe: "skip",
  });

  const candidates: TemplateCandidate[] = [];
  for (const rel of all) {
    if (extname(rel).toLowerCase() !== ".tex") continue;
    let body: string;
    try {
      body = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (!isMainDocument(body)) continue;
    const density = proseDensity(body);
    candidates.push({
      path: rel,
      score: scoreCandidate(root, rel, density),
      proseDensity: density,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const best = candidates[0] as TemplateCandidate;
  const runnerUp = candidates[1];

  if (runnerUp && best.score - runnerUp.score < DECISIVE_MARGIN) {
    throw new UserFacingError(
      `${root} holds more than one LaTeX document that could be the template, and they are ` +
        `too similar to choose between:\n` +
        candidates
          .slice(0, 5)
          .map((c) => `  ${c.path} (score ${c.score}, ${Math.round(c.proseDensity)} prose chars/section)`)
          .join("\n") +
        `\nPass --template <dir> to say which one to use.`,
    );
  }

  return {
    main: best.path,
    templateFiles: attribute(root, best.path, all),
    candidates,
    dedicatedDirectory: isDedicatedDirectory(root, best.path),
  };
}

/**
 * Where each claimed file lands inside the workspace `template/` tree.
 *
 * Fragments keep their path relative to the main file, because the template
 * `\input`s them by that path and flattening would break the reference.
 * Everything else is flattened to the root, because `compileLatex` scrubs
 * `TEXINPUTS` and runs `pdflatex` with the build directory as its working
 * directory -- a `.sty` left in a subdirectory is staged faithfully and then
 * not found. The three layouts in the corpus need both rules: one keeps the
 * whole kit in one directory, one puts the style file in a sibling `texmf/`,
 * and one has the class file three levels down inside a vendored source tree.
 *
 * The main file is renamed to `template.tex`. That name is not cosmetic:
 * `anonymityPreserved` and `templateCompatibility` both read
 * `template/template.tex`, and both fall back to a vacuous `pass` when it is
 * absent -- so a template whose main file were left as `main.tex` would turn
 * the de-anonymisation guard off while still reporting a green check.
 * `adaptVenueKit` normalises official kits the same way and for the same reason.
 */
export function templateLayout(discovery: TemplateDiscovery): Map<string, string> {
  const home = dirname(discovery.main);
  const layout = new Map<string, string>();
  for (const rel of discovery.templateFiles) {
    if (rel === discovery.main) {
      layout.set(rel, "template.tex");
      continue;
    }
    const relativeToMain = relative(home, rel);
    const isFragment =
      extname(rel).toLowerCase() === ".tex" && !relativeToMain.startsWith("..");
    layout.set(rel, isFragment ? relativeToMain : basename(rel));
  }
  return layout;
}
