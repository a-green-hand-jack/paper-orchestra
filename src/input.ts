import { execa } from "execa";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
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

function isNoiseDir(name: string): boolean {
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
export function importDirectory(from: string, to: string): ImportResult {
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

/** Figure assets supplied by the user, used when plotting is disabled. */
export function suppliedFigures(workspace: string): string[] {
  const dir = join(paths(workspace).source, "figures");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => [".pdf", ".png", ".jpg", ".jpeg"].includes(extname(name).toLowerCase()))
    .sort();
}
