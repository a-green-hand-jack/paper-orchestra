import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/paths.js";
import { acquireRunLock, lockHolder } from "../src/state/lock.js";
import { prepared } from "./fixtures.js";

function lockFile(workspace: string): string {
  return join(paths(workspace).runDir, "run.lock");
}

describe("run lock", () => {
  it("is held after acquire and gone after release", async () => {
    const { workspace } = await prepared();
    const lock = acquireRunLock(workspace);
    expect(existsSync(lockFile(workspace))).toBe(true);
    expect(lockHolder(workspace)).toMatchObject({ pid: process.pid, alive: true });
    lock.release();
    expect(existsSync(lockFile(workspace))).toBe(false);
  });

  it("refuses a second controller while the first is alive", async () => {
    // The defect this exists for: two controllers each re-read run.json every
    // step, so they interleave checkpoints and race state writes with
    // last-write-wins -- observed as two identical stage checkpoints with
    // different session ids while attempts still read 1.
    const { workspace } = await prepared();
    const lock = acquireRunLock(workspace);
    expect(() => acquireRunLock(workspace)).toThrow(/already being driven by pid/);
    lock.release();
  });

  it("names the holder and suggests a different output directory", async () => {
    const { workspace } = await prepared();
    const lock = acquireRunLock(workspace);
    expect(() => acquireRunLock(workspace)).toThrow(new RegExp(String(process.pid)));
    expect(() => acquireRunLock(workspace)).toThrow(/--output/);
    lock.release();
  });

  it("reclaims a stale lock whose holder is gone", async () => {
    // A kill -9 must not require manual cleanup before a resume.
    const { workspace } = await prepared();
    writeFileSync(
      lockFile(workspace),
      JSON.stringify({ pid: 2147483646, acquired_at: "2026-01-01T00:00:00.000Z", argv: "x" }),
    );
    const lock = acquireRunLock(workspace);
    const record = JSON.parse(readFileSync(lockFile(workspace), "utf8"));
    expect(record.pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims an unreadable lock file rather than deadlocking", async () => {
    const { workspace } = await prepared();
    writeFileSync(lockFile(workspace), "not json");
    const lock = acquireRunLock(workspace);
    expect(lockHolder(workspace)?.pid).toBe(process.pid);
    lock.release();
  });

  it("is idempotent on release", async () => {
    const { workspace } = await prepared();
    const lock = acquireRunLock(workspace);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("does not delete a lock another process has since reclaimed", async () => {
    const { workspace } = await prepared();
    const lock = acquireRunLock(workspace);
    writeFileSync(
      lockFile(workspace),
      JSON.stringify({ pid: 999999, acquired_at: "2026-01-01T00:00:00.000Z", argv: "other" }),
    );
    lock.release();
    expect(existsSync(lockFile(workspace))).toBe(true);
  });

  it("reports no holder when unlocked", async () => {
    const { workspace } = await prepared();
    expect(lockHolder(workspace)).toBeNull();
  });
});
