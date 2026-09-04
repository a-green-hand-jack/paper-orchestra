import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkFiles } from "../src/files.js";
import {
  MAX_IMPORT_FILES,
  importDirectory,
  isImportable,
  isSensitive,
  looksLikeText,
  prepareBrainInput,
} from "../src/input.js";
import { makeMessyRawMaterials, scratchDir } from "./fixtures.js";

function importMessy() {
  const from = makeMessyRawMaterials();
  const to = join(scratchDir("po-ws-"), "source");
  return { from, to, result: importDirectory(from, to) };
}

describe("a project directory imports instead of being silently dropped", () => {
  it("admits code, scripts, logs, config and extensionless files", () => {
    const { result } = importMessy();
    for (const rel of [
      "research_overview.md",
      "notes/brainstorm.md",
      "src/train.py",
      "scripts/run.sh",
      "logs/run1.log",
      "results.csv",
      "pyproject.toml",
      "LICENSE",
    ]) {
      expect(result.files, `${rel} should be imported`).toContain(rel);
    }
  });

  it("still refuses credentials, build artifacts and noise directories", () => {
    const { to, result } = importMessy();
    expect(result.files).not.toContain(".env");
    expect(existsSync(join(to, ".env"))).toBe(false);
    // A .pyc whose bytes decode as text must not slip through the sniff tier.
    expect(result.files).not.toContain("build/out.pyc");
    expect(result.files.some((f) => f.startsWith(".venv/"))).toBe(false);
    expect(result.files.some((f) => f.startsWith("__pycache__/"))).toBe(false);
  });

  it("does not re-import a previous run's workspace", () => {
    // `-o` defaults to ./po-run-<timestamp>, i.e. inside the materials
    // directory. .gitignore anticipated this; the import walk did not.
    const { result } = importMessy();
    expect(result.files.some((f) => f.startsWith("po-run-"))).toBe(false);
  });

  it("keeps a name that only looks like a credential", () => {
    const { result } = importMessy();
    expect(result.files).toContain("tokenizer_notes.md");
    expect(isSensitive("tokenizer_notes.md")).toBe(false);
    // The real ones stay caught.
    for (const name of ["slack-token.md", "my_api_key.txt", "db_credentials.json"]) {
      expect(isSensitive(name)).toBe(true);
    }
  });

  it("skips symlinks and reports them, without aborting the import", () => {
    const { to, result } = importMessy();
    expect(result.files).not.toContain("sneaky.md");
    expect(existsSync(join(to, "sneaky.md"))).toBe(false);
    expect(result.skippedByReason["symlink"]).toBe(2);
    // The invariant the change must not weaken: the digest walk over the
    // imported tree still refuses links.
    expect(() => walkFiles(to)).not.toThrow();
  });

  it("errors rather than importing nothing", () => {
    const from = scratchDir("po-empty-");
    mkdirSync(join(from, "build"), { recursive: true });
    writeFileSync(join(from, "build", "a.pyc"), "junk");
    expect(() => importDirectory(from, join(scratchDir("po-ws-"), "source"))).toThrow(
      /imported no files/,
    );
  });

  it("errors rather than truncating when the file cap is exceeded", () => {
    // Truncating would make provenance depend on filename sort order.
    const from = scratchDir("po-many-");
    for (let i = 0; i <= MAX_IMPORT_FILES; i += 1) {
      writeFileSync(join(from, `note-${i}.md`), "x");
    }
    expect(() => importDirectory(from, join(scratchDir("po-ws-"), "source"))).toThrow(
      /refusing to import more than/,
    );
  });

  it("reports skips grouped by reason", () => {
    const { result } = importMessy();
    expect(Object.keys(result.skippedByReason).sort()).toContain("sensitive");
    expect(result.bytes).toBeGreaterThan(0);
  });
});

describe("looksLikeText", () => {
  it("accepts text and rejects content with a NUL byte", () => {
    const dir = scratchDir("po-sniff-");
    writeFileSync(join(dir, "a.unknown"), "plain text\n");
    writeFileSync(join(dir, "b.unknown"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    expect(looksLikeText(join(dir, "a.unknown"))).toBe(true);
    expect(looksLikeText(join(dir, "b.unknown"))).toBe(false);
  });

  it("reports false for a path that cannot be read", () => {
    expect(looksLikeText(join(scratchDir("po-sniff-"), "absent"))).toBe(false);
  });
});

describe("isImportable", () => {
  it("admits the text tier alongside paper material", () => {
    for (const name of ["a.py", "a.sh", "a.toml", "a.log", "a.jsonl", "a.rst"]) {
      expect(isImportable(name), name).toBe(true);
    }
  });

  it("names build artifacts explicitly rather than relying on content", () => {
    for (const name of ["a.so", "a.pyc", "a.whl", "a.exe", "a.pt", "a.zip", "a.mp4"]) {
      expect(isImportable(name), name).toBe(false);
    }
  });
});

describe("prepareBrainInput", () => {
  it("skips an unreadable PDF instead of aborting the whole import", async () => {
    // This runs inside prepareWorkspace, so a throw here used to kill the run
    // before it started. The fixture's PDFs are deliberately malformed.
    const { to } = importMessy();
    const workspace = join(to, "..");
    const result = await prepareBrainInput(workspace);
    expect(result.skipped.join(" ")).toContain("pdf could not be converted");
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("namespaces converted PDFs so same-named files do not collide", async () => {
    // A flat basename.md means notes/results.pdf and data/results.pdf
    // overwrite each other -- normal once a directory is the input.
    const workspace = scratchDir("po-pdfns-");
    const source = join(workspace, "source");
    for (const dir of ["notes", "data"]) {
      mkdirSync(join(source, dir), { recursive: true });
      execFileSync("pdflatex", ["-interaction=nonstopmode", "-jobname", "results",
        "\\documentclass{article}\\begin{document}results\\end{document}"],
        { cwd: join(source, dir), stdio: "ignore" });
    }
    const result = await prepareBrainInput(workspace);
    expect(result.files.filter((p) => p.endsWith("results.md")).sort()).toEqual([
      join(".brain", "input", "data", "results.md"),
      join(".brain", "input", "notes", "results.md"),
    ]);
  }, 60_000);

  it("mirrors the text tier, not just markdown", async () => {
    const { to } = importMessy();
    const workspace = join(to, "..");
    await prepareBrainInput(workspace);
    const brain = join(workspace, ".brain", "input");
    expect(readdirSync(brain)).toContain("results.csv");
    expect(existsSync(join(brain, "src", "train.py"))).toBe(true);
  });
});
