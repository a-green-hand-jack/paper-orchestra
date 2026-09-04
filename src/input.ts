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
} from "./files.js";
import { INTERNAL_DIRS, paths } from "./paths.js";
import { authoredFiles, depthOf } from "./salience.js";

/**
 * Files that must never be copied into a workspace, because a workspace is
 * git-initialized and checkpointed: a credential imported once is in the run's
 * history permanently. Matched against the basename, case-insensitively.
 */
const SENSITIVE = [
  /^\.env($|\.)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^auth\.json$/i,
  /(^|[._-])(id_rsa|id_ed25519|id_ecdsa|id_dsa)($|[._-])/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  // Delimiter-bounded rather than a bare substring. An unanchored
  // /(token|secret|...)/ discards `tokenizer_notes.md` and
  // `secrets_rotation_design.md` as credentials -- real false positives on a
  // notes repository, and invisible ones, because a skipped file is only ever
  // reported as a line of prose. Every name the test table asserts is still
  // caught: `slack-token.md`, `my_api_key.txt`, `db_credentials.json`.
  /(^|[._-])(tokens?|secrets?|credentials?|passwords?|apikeys?|api[_-]?keys?)($|[._-])/i,
];

export function isSensitive(relPath: string): boolean {
  const name = basename(relPath);
  return SENSITIVE.some((re) => re.test(name));
}

/**
 * Extensions worth importing. An allowlist rather than a denylist: raw material
 * directories are often working directories with checkpoints, virtualenvs and
 * caches in them, and copying an unknown binary into a digested, read-only tree
 * is never what the user meant.
 */
const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".tex",
  ".bib",
  ".sty",
  ".cls",
  ".bst",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".eps",
]);

const ALLOWED_NAMES = new Set(["Makefile", "makefile", "latexmkrc", ".latexmkrc"]);

/**
 * Text formats a research directory carries that are not paper material.
 *
 * Kept as a second tier rather than folded into `ALLOWED_EXTENSIONS` so the
 * distinction stays legible: the first tier is what a manuscript is built from,
 * this one is what the experimental record is described in. A benchmark task
 * whose materials are a research overview plus a training repository is 60%
 * `.py` by file count, and that is where the experimental setup lives.
 */
const TEXT_EXTENSIONS = new Set([
  ".py",
  ".ipynb",
  ".r",
  ".jl",
  ".sh",
  ".bash",
  ".zsh",
  ".log",
  ".jsonl",
  ".ndjson",
  ".rst",
  ".org",
  ".toml",
  ".cfg",
  ".ini",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".go",
  ".rs",
  ".java",
  ".sql",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
]);

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

/** Per-file ceilings. Text is capped low; a figure or PDF legitimately is not. */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;

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

export function isImportable(relPath: string): boolean {
  const name = basename(relPath);
  if (ALLOWED_NAMES.has(name)) return true;
  const extension = extname(name).toLowerCase();
  if (NEVER_IMPORT_EXTENSIONS.has(extension)) return false;
  return ALLOWED_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
}

/** Whether an unknown extension may be admitted by sniffing its content. */
function mayBeSniffed(relPath: string): boolean {
  const extension = extname(basename(relPath)).toLowerCase();
  return !NEVER_IMPORT_EXTENSIONS.has(extension) && !isBinaryMaterial(relPath);
}

/**
 * Extensions that are never research material, whatever their bytes look like.
 *
 * The sniff tier exists for *unknown* extensions. Without this list it would
 * also admit build artifacts and archives whose leading bytes happen to decode
 * as text -- an empty `.pyc`, a text-shaped `.dat` -- and "the sample looked
 * like text" is not a reason to import a compiled object. Checked before the
 * sniff, so the decision never depends on file content for a format we can
 * already name.
 */
const NEVER_IMPORT_EXTENSIONS = new Set([
  ".so", ".pyc", ".pyo", ".pyd", ".whl", ".egg", ".exe", ".dll", ".dylib",
  ".a", ".o", ".obj", ".class", ".jar", ".war",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".pkl", ".pickle", ".npy", ".npz", ".pt", ".pth", ".ckpt", ".safetensors",
  ".h5", ".hdf5", ".onnx", ".pb", ".tflite",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac",
  ".iso", ".dmg", ".deb", ".rpm",
]);

/** Extensions whose content is not text and must not be sniffed. */
function isBinaryMaterial(relPath: string): boolean {
  return [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".eps"].includes(
    extname(relPath).toLowerCase(),
  );
}

export interface ImportResult {
  readonly files: string[];
  readonly skipped: string[];
  /** Skip counts by reason, so a caller can summarize instead of listing. */
  readonly skippedByReason: Record<string, number>;
  readonly bytes: number;
}

/**
 * Copy a directory into the workspace, then lock it.
 *
 * Unsafe entries are skipped rather than refused: this walk is over the user's
 * own directory, so a symlink here is never copied and therefore never enters
 * the digest set (see `walkFiles`). The digest walk over `source/` keeps the
 * throwing default.
 *
 * Importing nothing is an error. A materials directory that yields zero files
 * used to print a list of skips and exit 0, leaving the failure to surface
 * later as an outline agent reading a path that does not exist.
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
  if (!existsSync(from)) {
    throw new UnsafePathError(`input directory does not exist: ${from}`);
  }
  if (statKind(from) !== "dir") {
    throw new UnsafePathError(`input is not a directory: ${from}`);
  }

  const skipped: string[] = [];
  const skippedByReason: Record<string, number> = {};
  const note = (rel: string, reason: string): void => {
    skipped.push(`${rel} (${reason})`);
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  };

  const candidates = walkFiles(from, {
    skipDirs: INTERNAL_DIRS,
    skipDir: isNoiseDir,
    onUnsafe: "skip",
    onSkip: (rel, reason) => note(rel, reason),
  });

  const keep: string[] = [];
  let bytes = 0;

  for (const rel of candidates) {
    if (options.exclude?.has(rel)) {
      note(rel, "belongs to the template");
      continue;
    }
    if (isSensitive(rel)) {
      note(rel, "sensitive");
      continue;
    }

    const abs = join(from, rel);
    const size = statSync(abs).size;
    const binary = isBinaryMaterial(rel);
    const cap = binary ? MAX_BINARY_FILE_BYTES : MAX_TEXT_FILE_BYTES;
    if (size > cap) {
      note(rel, `too large (${size} bytes, cap ${cap})`);
      continue;
    }

    if (!isImportable(rel)) {
      // Unknown extension, or none at all: admit it if it reads as text. This
      // is what lets README/LICENSE/Dockerfile through without a name list.
      if (!mayBeSniffed(rel) || !looksLikeText(abs)) {
        note(rel, "not importable");
        continue;
      }
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

  if (keep.length === 0) {
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
  for (const rel of keep) {
    const target = assertInside(to, rel);
    ensureDir(dirname(target));
    copyFileSync(join(from, rel), target);
  }
  makeReadOnly(to, keep);

  return { files: keep, skipped, skippedByReason, bytes };
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
    copyFileSync(join(root, rel), target);
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

/**
 * Convert a PDF into markdown for the agent to read. Poppler's `pdftotext` is
 * used rather than PyMuPDF because it is present without a Python environment,
 * and the layout flag keeps tables legible enough to be quoted.
 *
 * `relPath` namespaces the output by its source path. Writing a flat
 * `basename.md` means `notes/results.pdf` and `data/results.pdf` silently
 * overwrite each other -- unlikely with two hand-picked documents, normal once
 * a whole directory is the input, and data loss either way.
 */
export async function convertPdfToText(
  pdf: string,
  outDir: string,
  relPath?: string,
): Promise<string> {
  const rel = relPath ?? basename(pdf);
  const target = assertInside(outDir, join(dirname(rel), `${basename(rel, extname(rel))}.md`));
  ensureDir(dirname(target));
  await execa("pdftotext", ["-layout", pdf, target]);
  return target;
}

export interface BrainInputResult {
  readonly files: string[];
  /** Files that could not be normalized, with the reason. */
  readonly skipped: string[];
}

/**
 * Normalize imported material into `.brain/input/`, which is what the agent
 * reads. `source/` stays pristine and read-only; anything derived lands here so
 * the lock over `source/` is never disturbed by our own preprocessing.
 *
 * Every text-tier file is mirrored, not just `.md`/`.txt`. Anything left out of
 * this view is invisible to a stage that reads only the normalized tree, which
 * previously stranded `.csv`, `.json`, `.bib` and `.yaml` inside `source/`.
 *
 * A PDF that will not convert is skipped rather than fatal. `pdftotext` exits
 * non-zero on a malformed or encrypted file, and this runs inside
 * `prepareWorkspace`, so one unreadable PDF used to abort the whole run before
 * it started -- a small risk with two hand-picked documents, a likely one once
 * a whole directory is the input.
 */
export async function prepareBrainInput(workspace: string): Promise<BrainInputResult> {
  const p = paths(workspace);
  ensureDir(p.brainInput);
  const produced: string[] = [];
  const skipped: string[] = [];

  for (const rel of walkFiles(p.source)) {
    const abs = join(p.source, rel);
    const extension = extname(rel).toLowerCase();

    if (extension === ".pdf") {
      try {
        produced.push(await convertPdfToText(abs, p.brainInput, rel));
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        skipped.push(`${rel} (pdf could not be converted: ${detail})`);
      }
      continue;
    }
    if (isBinaryMaterial(rel)) continue;

    const target = assertInside(p.brainInput, rel);
    ensureDir(dirname(target));
    copyFileSync(abs, target);
    produced.push(target);
  }
  return { files: produced.map((path) => relative(workspace, path)), skipped };
}

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
const FIGURE_DIR_NAMES = new Set(["figures", "figure", "figs", "fig", "images", "imgs", "plots"]);

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
  const byDir = new Map<string, number>();
  for (const rel of authoredFiles(root)) {
    if (!FIGURE_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
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

/**
 * Ceilings under which the materials can simply be read in full.
 *
 * The triage stage exists to make a large input tractable: it says which of
 * several hundred files are worth opening. A handful of notes needs none of
 * that -- every stage can read all of it -- and running a model to produce a
 * map of three files would spend tokens to restate a directory listing.
 *
 * This replaces the previous router, which asked whether the author had
 * supplied two files with particular names. That question only had an answer
 * for inputs shaped the way one benchmark shapes them; "is this small enough to
 * read whole" has an answer for any input, which is the property a general
 * tool needs.
 *
 * Both ceilings, because either alone is escapable in a way that matters: 400
 * tiny files are small in bytes and still need a map, and one 5 MB log is a
 * single file nobody can read whole.
 *
 * Measured against the corpus this is tuned on, no task qualifies -- the
 * smallest holds 133 KB of text across 30 files. That is the correct outcome
 * and worth stating: these tasks are exactly the case the mapping stage is for.
 */
export const READ_WHOLE_MAX_BYTES = 64 * 1024;
export const READ_WHOLE_MAX_FILES = 25;

/**
 * Can every stage just read all of the normalized materials?
 *
 * Deterministic and recomputed rather than recorded, so the controller's
 * decision to skip the mapping stage and the validator's expectation of a
 * missing map cannot disagree. A flag in `.brain/` would be writable by the
 * agent being validated; a flag in `run.json` would freeze a decision that
 * depends on a tree the run can still be resumed against.
 */
export function materialsFitWhole(workspace: string): boolean {
  const p = paths(workspace);
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
  const files = walkFiles(p.brainInput)
    .filter((rel) => !rel.startsWith(`synthesized${sep}`) && rel !== "synthesized")
    .map((rel) => ({ rel, bytes: statSync(join(p.brainInput, rel)).size }));

  if (files.length === 0) return "(no normalized material found)";

  const header = `${files.length} file(s) under .brain/input/`;
  if (files.length <= maxEntries) {
    return [
      header,
      "",
      ...files.map((f) => `  ${f.rel}  (${f.bytes} bytes)`),
    ].join("\n");
  }

  const byDir = new Map<string, { count: number; bytes: number }>();
  for (const f of files) {
    const dir = f.rel.includes(sep) ? f.rel.slice(0, f.rel.lastIndexOf(sep)) : ".";
    const entry = byDir.get(dir) ?? { count: 0, bytes: 0 };
    byDir.set(dir, { count: entry.count + 1, bytes: entry.bytes + f.bytes });
  }
  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 40);
  return [
    `${header}, too many to list individually. Directory summary:`,
    "",
    ...[...byDir.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([dir, e]) => `  ${dir}/  ${e.count} file(s), ${e.bytes} bytes`),
    "",
    "Largest files:",
    "",
    ...largest.map((f) => `  ${f.rel}  (${f.bytes} bytes)`),
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
  const candidates = walkFiles(root, {
    skipDirs: INTERNAL_DIRS,
    skipDir: isNoiseDir,
    onUnsafe: "skip",
  }).filter((rel) => {
    if (isSensitive(rel)) return false;
    if (isBinaryMaterial(rel)) return false;
    const extension = extname(rel).toLowerCase();
    if (NEVER_IMPORT_EXTENSIONS.has(extension)) return false;
    const abs = join(root, rel);
    try {
      if (statSync(abs).size > MAX_TEXT_FILE_BYTES) return false;
    } catch {
      return false;
    }
    return isImportable(rel) || looksLikeText(abs);
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
      body = readFileSync(join(root, rel), "utf8").slice(0, perFile);
    } catch {
      continue;
    }
    const block = `<file path="${rel}">\n${body}\n</file>`;
    used += block.length;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}
