import { execa } from "execa";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnsafePathError } from "../src/files.js";
import {
  assertArchiveSafe,
  importDirectory,
  isImportable,
  isSensitive,
  suppliedFigures,
} from "../src/input.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "po-input-"));
}

describe("sensitive file detection", () => {
  it.each([
    ".env",
    ".env.local",
    ".npmrc",
    ".netrc",
    "auth.json",
    "id_rsa",
    "id_ed25519.pub",
    "server.pem",
    "cert.p12",
    "my_api_key.txt",
    "slack-token.md",
    "db_credentials.json",
  ])("refuses %s", (name) => {
    expect(isSensitive(name)).toBe(true);
  });

  it.each(["idea_sparse.md", "experimental_log.md", "references.bib", "template.tex"])(
    "allows %s",
    (name) => {
      expect(isSensitive(name)).toBe(false);
    },
  );

  it("matches on the basename, so a nested .env is still caught", () => {
    expect(isSensitive("deep/nested/.env")).toBe(true);
  });
});

describe("importable extensions", () => {
  it("accepts paper material", () => {
    for (const name of ["a.md", "a.tex", "a.bib", "a.sty", "a.bst", "a.pdf", "a.png", "Makefile"]) {
      expect(isImportable(name)).toBe(true);
    }
  });

  it("rejects binaries and caches an allowlist would not name", () => {
    for (const name of ["a.so", "a.pyc", "a.whl", "a.exe"]) {
      expect(isImportable(name)).toBe(false);
    }
  });
});

describe("importDirectory", () => {
  it("copies material, locks it read-only, and reports what it skipped", () => {
    const from = scratch();
    const to = join(scratch(), "source");
    writeFileSync(join(from, "idea_sparse.md"), "# idea");
    writeFileSync(join(from, "experimental_log.md"), "# log");
    writeFileSync(join(from, ".env"), "OPENAI_API_KEY=sk-secret");
    writeFileSync(join(from, "scratch.pyc"), "junk");
    mkdirSync(join(from, "figures"));
    writeFileSync(join(from, "figures", "fig1.png"), "png");

    const result = importDirectory(from, to);

    expect(result.files.sort()).toEqual([
      "experimental_log.md",
      "figures/fig1.png",
      "idea_sparse.md",
    ]);
    expect(statSync(join(to, "idea_sparse.md")).mode & 0o222).toBe(0);

    const skippedNames = result.skipped.join(" ");
    expect(skippedNames).toContain(".env (sensitive)");
    expect(skippedNames).toContain("scratch.pyc");
  });

  it("never copies a credential into the workspace", () => {
    // A workspace is git-initialized and checkpointed, so one imported
    // credential is in the run history permanently.
    const from = scratch();
    const to = join(scratch(), "source");
    writeFileSync(join(from, ".env"), "SECRET=1");
    writeFileSync(join(from, "idea_sparse.md"), "# idea");
    const result = importDirectory(from, to);
    expect(result.files).not.toContain(".env");
  });

  it("refuses the whole import when material contains a symlink", () => {
    const from = scratch();
    writeFileSync(join(from, "idea_sparse.md"), "# idea");
    symlinkSync("/etc/passwd", join(from, "sneaky.md"));
    expect(() => importDirectory(from, join(scratch(), "source"))).toThrow(UnsafePathError);
  });

  it("refuses a missing or non-directory input", () => {
    expect(() => importDirectory(join(scratch(), "absent"), join(scratch(), "s"))).toThrow(
      /does not exist/,
    );
    const file = join(scratch(), "a.md");
    writeFileSync(file, "x");
    expect(() => importDirectory(file, join(scratch(), "s"))).toThrow(/not a directory/);
  });
});

describe("archive inspection", () => {
  it("rejects a tar member that escapes the destination", async () => {
    const dir = scratch();
    const payload = join(dir, "payload.md");
    writeFileSync(payload, "x");
    const archive = join(dir, "evil.tar");
    // Store the member with a traversal prefix without ever writing outside.
    await execa("tar", ["--transform", "s|.*|../escaped.md|", "-cf", archive, "payload.md"], {
      cwd: dir,
    });
    await expect(assertArchiveSafe(archive, join(dir, "dest"))).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it("accepts a well-formed archive", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "idea.md"), "x");
    const archive = join(dir, "good.tar");
    await execa("tar", ["-cf", archive, "idea.md"], { cwd: dir });
    await expect(assertArchiveSafe(archive, join(dir, "dest"))).resolves.toContain("idea.md");
  });

  it("refuses an unsupported archive format", async () => {
    await expect(assertArchiveSafe(join(scratch(), "a.rar"), scratch())).rejects.toThrow(
      /unsupported archive/,
    );
  });
});

describe("suppliedFigures", () => {
  it("lists raster and pdf figures, ignoring everything else", () => {
    const workspace = scratch();
    const figures = join(workspace, "source", "figures");
    mkdirSync(figures, { recursive: true });
    for (const name of ["b.png", "a.pdf", "notes.md"]) {
      writeFileSync(join(figures, name), "x");
    }
    expect(suppliedFigures(workspace)).toEqual(["a.pdf", "b.png"]);
  });

  it("returns nothing when no figures directory exists", () => {
    expect(suppliedFigures(scratch())).toEqual([]);
  });
});
