import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UserFacingError } from "./errors.js";

/**
 * Thrown when a path is refused for safety reasons rather than I/O failure.
 * User-facing: a symlink in imported material is a decision for the operator,
 * not a bug, so it prints as a message rather than a stack trace.
 */
export class UnsafePathError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Write JSON so a reader never observes a partial file: serialize to
 * `<path>.<pid>.tmp` in the same directory, then rename. Rename is atomic
 * within a filesystem, which is what makes a concurrent `status` safe while the
 * controller is mid-write.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIfExists<T = unknown>(path: string): T | null {
  return existsSync(path) ? readJson<T>(path) : null;
}

/** sha256 of a canonical JSON rendering, used for the scope digest. */
export function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * One digest over a set of files. Path and content are both folded in, with a
 * NUL separator so a rename cannot collide with a content change, and the list
 * is sorted so the result is independent of walk order.
 */
export function digestTree(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const rel of [...files].sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export interface WalkOptions {
  /** Directory names to skip entirely. */
  readonly skipDirs?: readonly string[];
  /**
   * Skip a directory by predicate, for families a fixed list cannot express
   * (workspace directories are named `po-run-<timestamp>`).
   */
  readonly skipDir?: (name: string) => boolean;
  /** Predicate on the relative path; false skips the file. */
  readonly accept?: (relPath: string) => boolean;
  /**
   * What to do with a symlink or a non-regular file. Defaults to `"throw"`, so
   * every existing caller keeps refusing them.
   */
  readonly onUnsafe?: "throw" | "skip";
  /** Called with each entry `"skip"` passed over, for reporting. */
  readonly onSkip?: (relPath: string, reason: "symlink" | "special file") => void;
}

/**
 * Walk a tree and return relative file paths.
 *
 * Symlinks and anything that is neither a regular file nor a directory (fifos,
 * sockets, devices) are refused by default. A symlink inside *imported*
 * material could point at `/etc/passwd` or escape the workspace, and it would
 * be digested as its target rather than as a link, so silently skipping it
 * would be worse than failing: the lock would not detect a later retarget.
 *
 * That reasoning applies to the digest walk over `source/` and `template/`,
 * which is why `onUnsafe` defaults to `"throw"` and why `protectedFiles` must
 * keep the default. It does NOT apply to the candidate walk over the user's own
 * raw materials: a skipped symlink is never copied, so it never enters the
 * digest set and there is nothing to retarget. Refusing there instead means a
 * repository containing a virtualenv or a `latest ->` pointer cannot be
 * imported at all, which is a real materials directory failing on a link the
 * run would never have read.
 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const skip = new Set(options.skipDirs ?? []);
  const unsafe = options.onUnsafe ?? "throw";
  const out: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);

      if (entry.isSymbolicLink()) {
        if (unsafe === "throw") throw new UnsafePathError(`refusing symlink: ${rel}`);
        options.onSkip?.(rel, "symlink");
        continue;
      }
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !options.skipDir?.(entry.name)) visit(abs);
        continue;
      }
      if (!entry.isFile()) {
        if (unsafe === "throw") throw new UnsafePathError(`refusing special file: ${rel}`);
        options.onSkip?.(rel, "special file");
        continue;
      }
      if (options.accept && !options.accept(rel)) continue;
      out.push(rel);
    }
  };

  if (existsSync(root)) visit(root);
  return out.sort();
}

/**
 * Make imported material read-only. This is belt to the digest's braces: the
 * digest detects a change after the fact, while the mode stops the common
 * accident of an agent editing its own inputs to satisfy a validator.
 */
export function makeReadOnly(root: string, files: readonly string[]): void {
  for (const rel of files) chmodSync(join(root, rel), 0o444);
}

/**
 * Resolve `candidate` and confirm it stays inside `root`.
 *
 * Used for archive members and any agent-supplied path. Compares with a
 * trailing separator so `/tmp/work-evil` is not accepted as inside `/tmp/work`.
 */
export function assertInside(root: string, candidate: string): string {
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new UnsafePathError(`path escapes workspace: ${candidate}`);
  }
  return target;
}

export function statKind(path: string): "file" | "dir" | "symlink" | "other" {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}
