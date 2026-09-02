import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnsafePathError,
  assertInside,
  digestTree,
  digestValue,
  makeReadOnly,
  readJsonIfExists,
  walkFiles,
  writeJsonAtomic,
} from "../src/files.js";

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "po-files-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  roots.length = 0;
});

describe("atomic json", () => {
  it("writes and reads back", () => {
    const dir = scratch();
    const file = join(dir, "nested", "run.json");
    writeJsonAtomic(file, { a: 1 });
    expect(readJsonIfExists(file)).toEqual({ a: 1 });
  });

  it("leaves no temp file behind", () => {
    const dir = scratch();
    writeJsonAtomic(join(dir, "x.json"), { a: 1 });
    expect(walkFiles(dir)).toEqual(["x.json"]);
  });

  it("returns null for a missing file rather than throwing", () => {
    expect(readJsonIfExists(join(scratch(), "absent.json"))).toBeNull();
  });
});

describe("digests", () => {
  it("is stable regardless of the order files are listed in", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.md"), "alpha");
    writeFileSync(join(dir, "b.md"), "beta");
    expect(digestTree(dir, ["a.md", "b.md"])).toBe(digestTree(dir, ["b.md", "a.md"]));
  });

  it("changes when content changes", () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.md"), "alpha");
    const before = digestTree(dir, ["a.md"]);
    writeFileSync(join(dir, "a.md"), "alphaa");
    expect(digestTree(dir, ["a.md"])).not.toBe(before);
  });

  it("distinguishes a rename from a content change", () => {
    // The NUL separator exists for this: without folding the path in, moving
    // content between two files would leave the tree digest unchanged.
    const dir = scratch();
    writeFileSync(join(dir, "a.md"), "x");
    writeFileSync(join(dir, "b.md"), "");
    const before = digestTree(dir, ["a.md", "b.md"]);
    writeFileSync(join(dir, "a.md"), "");
    writeFileSync(join(dir, "b.md"), "x");
    expect(digestTree(dir, ["a.md", "b.md"])).not.toBe(before);
  });

  it("digests values canonically", () => {
    expect(digestValue({ a: 1 })).toBe(digestValue({ a: 1 }));
    expect(digestValue({ a: 1 })).not.toBe(digestValue({ a: 2 }));
    expect(digestValue({ a: 1 })).toHaveLength(64);
  });
});

describe("walkFiles safety", () => {
  it("refuses a symlink rather than skipping it", () => {
    // Skipping would be worse than failing: the lock would not notice a later
    // retarget of the link.
    const dir = scratch();
    writeFileSync(join(dir, "real.md"), "x");
    symlinkSync(join(dir, "real.md"), join(dir, "link.md"));
    expect(() => walkFiles(dir)).toThrow(UnsafePathError);
  });

  it("skips named directories", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    writeFileSync(join(dir, "keep.md"), "x");
    expect(walkFiles(dir, { skipDirs: [".git"] })).toEqual(["keep.md"]);
  });

  it("applies the accept predicate", () => {
    const dir = scratch();
    writeFileSync(join(dir, "keep.md"), "x");
    writeFileSync(join(dir, "drop.bin"), "x");
    expect(walkFiles(dir, { accept: (p) => p.endsWith(".md") })).toEqual(["keep.md"]);
  });

  it("returns an empty list for a missing root", () => {
    expect(walkFiles(join(scratch(), "nope"))).toEqual([]);
  });
});

describe("assertInside", () => {
  it("accepts a path within the root", () => {
    expect(assertInside("/tmp/work", "a/b.tex")).toBe("/tmp/work/a/b.tex");
  });

  it("rejects traversal", () => {
    expect(() => assertInside("/tmp/work", "../escape.tex")).toThrow(UnsafePathError);
    expect(() => assertInside("/tmp/work", "a/../../escape.tex")).toThrow(UnsafePathError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => assertInside("/tmp/work", "/etc/passwd")).toThrow(UnsafePathError);
  });

  it("rejects a sibling directory sharing the root's prefix", () => {
    // "/tmp/work-evil" must not count as inside "/tmp/work".
    expect(() => assertInside("/tmp/work", "../work-evil/x")).toThrow(UnsafePathError);
  });
});

describe("makeReadOnly", () => {
  it("strips write bits from imported material", () => {
    const dir = scratch();
    writeFileSync(join(dir, "idea.md"), "x");
    makeReadOnly(dir, ["idea.md"]);
    expect(statSync(join(dir, "idea.md")).mode & 0o222).toBe(0);
    expect(readFileSync(join(dir, "idea.md"), "utf8")).toBe("x");
  });
});
