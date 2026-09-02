import { execa } from "execa";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
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
  /(token|secret|credential|password|apikey|api_key)/i,
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

export function isImportable(relPath: string): boolean {
  const name = basename(relPath);
  if (ALLOWED_NAMES.has(name)) return true;
  return ALLOWED_EXTENSIONS.has(extname(name).toLowerCase());
}

export interface ImportResult {
  readonly files: string[];
  readonly skipped: string[];
}

/**
 * Copy a directory into the workspace, then lock it.
 *
 * `walkFiles` throws on symlinks and special files, so the refusal happens
 * before anything is copied — an import either lands whole or not at all.
 */
export function importDirectory(from: string, to: string): ImportResult {
  if (!existsSync(from)) {
    throw new UnsafePathError(`input directory does not exist: ${from}`);
  }
  if (statKind(from) !== "dir") {
    throw new UnsafePathError(`input is not a directory: ${from}`);
  }

  const skipped: string[] = [];
  const candidates = walkFiles(from, { skipDirs: INTERNAL_DIRS });
  const keep: string[] = [];

  for (const rel of candidates) {
    if (isSensitive(rel)) {
      skipped.push(`${rel} (sensitive)`);
      continue;
    }
    if (!isImportable(rel)) {
      skipped.push(`${rel} (extension not importable)`);
      continue;
    }
    keep.push(rel);
  }

  ensureDir(to);
  for (const rel of keep) {
    const target = assertInside(to, rel);
    ensureDir(dirname(target));
    copyFileSync(join(from, rel), target);
  }
  makeReadOnly(to, keep);

  return { files: keep, skipped };
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
 */
export async function convertPdfToText(pdf: string, outDir: string): Promise<string> {
  ensureDir(outDir);
  const out = join(outDir, `${basename(pdf, extname(pdf))}.md`);
  await execa("pdftotext", ["-layout", pdf, out]);
  return out;
}

/**
 * Normalize imported material into `.brain/input/`, which is what the agent
 * reads. `source/` stays pristine and read-only; anything derived lands here so
 * the lock over `source/` is never disturbed by our own preprocessing.
 */
export async function prepareBrainInput(workspace: string): Promise<string[]> {
  const p = paths(workspace);
  ensureDir(p.brainInput);
  const produced: string[] = [];

  for (const rel of walkFiles(p.source)) {
    const abs = join(p.source, rel);
    if (extname(rel).toLowerCase() === ".pdf") {
      produced.push(await convertPdfToText(abs, p.brainInput));
      continue;
    }
    if ([".md", ".txt"].includes(extname(rel).toLowerCase())) {
      const target = assertInside(p.brainInput, rel);
      ensureDir(dirname(target));
      copyFileSync(abs, target);
      produced.push(target);
    }
  }
  return produced.map((path) => relative(workspace, path));
}

/** Figure assets supplied by the user, used when plotting is disabled. */
export function suppliedFigures(workspace: string): string[] {
  const dir = join(paths(workspace).source, "figures");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => [".pdf", ".png", ".jpg", ".jpeg"].includes(extname(name).toLowerCase()))
    .sort();
}
