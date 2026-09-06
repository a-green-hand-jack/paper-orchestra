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
  return parseJson<T>(readFileSync(path, "utf8"), path);
}

/** Native parsing on success; version-independent, bounded diagnostics on failure. */
export function parseJson<T = unknown>(text: string, filename: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  // V8 sometimes omits positions or embeds source in its error. Walk the grammar
  // only after rejection, without building values or recursing on nested input.
  type State = "value" | "arrayStart" | "key" | "objectStart" | "colon"
    | "arrayNext" | "objectNext" | "end";
  const pending: State[] = ["end", "value"];
  let at = 0;
  const invalid = (reason: string): never => {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < at; i++) {
      if (text[i] === "\r" || text[i] === "\n") {
        if (text[i] === "\r" && text[i + 1] === "\n" && i + 1 < at) i++;
        line++;
        lineStart = i + 1;
      }
    }
    throw new UserFacingError(
      `Invalid JSON in ${filename} at line ${line}, column ${at - lineStart + 1} (offset ${at}): ${reason}`,
    );
  };
  const string = (): void => {
    at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return;
      if (char === "\\") {
        if (at === text.length) invalid("unterminated string escape");
        const escape = text[at];
        if (escape === "u") {
          at++;
          for (let i = 0; i < 4; i++, at++) {
            if (at === text.length || !/[0-9a-fA-F]/.test(text[at]!)) invalid("expected a hexadecimal escape digit");
          }
        } else {
          if (!'"\\/bfnrt'.includes(escape!)) invalid("invalid string escape");
          at++;
        }
      } else if (char!.charCodeAt(0) < 32) {
        at--;
        invalid("unescaped control character in string");
      }
    }
    invalid("unterminated string");
  };
  while (pending.length) {
    while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++;
    const state = pending.pop()!;
    const char = text[at];
    if (state === "end") {
      if (at !== text.length) invalid("unexpected content after JSON value");
    } else if (state === "colon") {
      if (char !== ":") invalid("expected ':' after object key");
      at++;
    } else if (state === "arrayNext" || state === "objectNext") {
      const array = state === "arrayNext";
      if (char === (array ? "]" : "}")) at++;
      else if (char === ",") {
        at++;
        pending.push(state, array ? "value" : "key");
      } else invalid(`expected ',' or '${array ? "]" : "}"}'`);
    } else if (state === "key" || state === "objectStart") {
      if (state === "objectStart" && char === "}") {
        at++;
        continue;
      }
      if (char !== '"') invalid("expected a quoted object key");
      string();
      if (state === "objectStart") pending.push("objectNext");
      pending.push("value", "colon");
    } else {
      if (state === "arrayStart") {
        if (char === "]") {
          at++;
          continue;
        }
        pending.push("arrayNext");
      }
      if (char === "{" || char === "[") {
        at++;
        pending.push(char === "{" ? "objectStart" : "arrayStart");
      } else if (char === '"') string();
      else if (char === "t" || char === "f" || char === "n") {
        const literal = char === "t" ? "true" : char === "f" ? "false" : "null";
        for (const expected of literal) {
          if (text[at] !== expected) invalid(`expected '${literal}'`);
          at++;
        }
      } else {
        if (char === "-") at++;
        if (text[at] === "0") at++;
        else {
          if (at === text.length || !/[1-9]/.test(text[at]!)) invalid("expected a JSON value");
          while (at < text.length && /[0-9]/.test(text[at]!)) at++;
        }
        if (text[at] === ".") {
          at++;
          if (at === text.length || !/[0-9]/.test(text[at]!)) invalid("expected a digit after decimal point");
          while (at < text.length && /[0-9]/.test(text[at]!)) at++;
        }
        if (text[at] === "e" || text[at] === "E") {
          at++;
          if (text[at] === "+" || text[at] === "-") at++;
          if (at === text.length || !/[0-9]/.test(text[at]!)) invalid("expected an exponent digit");
          while (at < text.length && /[0-9]/.test(text[at]!)) at++;
        }
      }
    }
  }
  return invalid("invalid JSON");
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
