import { openSync, closeSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { UserFacingError } from "../errors.js";
import { ensureDir } from "../files.js";
import { paths } from "../paths.js";

/**
 * An exclusive lock over a run workspace.
 *
 * Without one, two controllers can drive the same workspace at once: each
 * re-reads `run.json` at every step, so they interleave checkpoints and race
 * state writes with last-write-wins. That is not hypothetical -- it happened
 * during development when an orphaned controller kept polling after its
 * supervising shell was killed, then adopted a freshly prepared run in the same
 * directory. The result was two `outline` checkpoints with different session
 * ids while `attempts` still read 1, because both processes wrote 0 -> 1.
 *
 * `wx` makes creation atomic, so acquiring is a single syscall with no
 * check-then-act window.
 */
export interface RunLock {
  release(): void;
}

interface LockRecord {
  readonly pid: number;
  readonly acquired_at: string;
  readonly argv: string;
}

function lockPath(workspace: string): string {
  return join(paths(workspace).runDir, "run.lock");
}

/** Whether a process is still alive. Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(workspace: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(lockPath(workspace), "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Take the lock, reclaiming it only when the holder is demonstrably gone.
 *
 * A crashed controller leaves its lock behind; refusing forever would make a
 * kill -9 require manual cleanup, so a lock whose pid is dead is stale and gets
 * reclaimed. A lock whose pid is alive is refused, naming the pid so the
 * operator can decide.
 */
export function acquireRunLock(workspace: string): RunLock {
  const path = lockPath(workspace);
  ensureDir(paths(workspace).runDir);

  const record: LockRecord = {
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    argv: process.argv.slice(1).join(" "),
  };

  const write = (): void => {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
  };

  try {
    write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const existing = readLock(workspace);
    if (existing && isAlive(existing.pid)) {
      throw new UserFacingError(
        `workspace ${workspace} is already being driven by pid ${existing.pid} ` +
          `(since ${existing.acquired_at}). Two controllers on one workspace interleave ` +
          `checkpoints and corrupt run state. Stop that process, or use a different ` +
          `--output directory.`,
      );
    }

    // Stale: the holder is gone. Reclaim.
    rmSync(path, { force: true });
    write();
  }

  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      // Only remove a lock we still own, so a reclaim by someone else is not
      // deleted out from under them.
      const current = readLock(workspace);
      if (!current || current.pid === process.pid) rmSync(path, { force: true });
    },
  };
}

/** Who holds the lock, for `status`. */
export function lockHolder(workspace: string): { pid: number; alive: boolean } | null {
  const record = readLock(workspace);
  if (!record) return null;
  return { pid: record.pid, alive: isAlive(record.pid) };
}
