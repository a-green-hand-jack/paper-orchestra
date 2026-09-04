import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  ANONYMITY_OPTIONS,
  finalCopyCommands,
  packageOptions,
} from "../src/latex.js";
import { compileLatex } from "../src/latexbuild.js";
import { validators } from "../src/validation.js";
import { templateAdapter } from "../src/venue-catalog.js";
import { templateRoot } from "../src/venues.js";
import { scratchDir } from "./fixtures.js";

describe("packageOptions", () => {
  it("returns the option list a package is loaded with", () => {
    expect(packageOptions("\\usepackage[review]{cvpr}", "cvpr")).toEqual(["review"]);
  });

  it("distinguishes a bare load from an absent one", () => {
    // `[]` and `null` must not be conflated: bare means "loaded, no options",
    // which is exactly the CVPR bug this check exists to catch.
    expect(packageOptions("\\usepackage{cvpr}", "cvpr")).toEqual([]);
    expect(packageOptions("\\usepackage{graphicx}", "cvpr")).toBeNull();
  });

  it("finds a package inside a comma-separated load", () => {
    expect(packageOptions("\\usepackage[preprint]{neurips_2025,times}", "times")).toEqual([
      "preprint",
    ]);
  });

  it("unions the options of a package loaded twice, as LaTeX does", () => {
    expect(
      packageOptions("\\usepackage[review]{cvpr}\n\\usepackage[pagenumbers]{cvpr}", "cvpr"),
    ).toEqual(["review", "pagenumbers"]);
  });

  it("reads \\RequirePackage as well", () => {
    expect(packageOptions("\\RequirePackage[review]{cvpr}", "cvpr")).toEqual(["review"]);
  });
});

describe("finalCopyCommands", () => {
  it("detects a real camera-ready switch", () => {
    expect(finalCopyCommands("\\iclrfinalcopy")).toEqual(["\\iclrfinalcopy"]);
  });

  it("ignores a commented-out switch", () => {
    expect(finalCopyCommands("% \\iclrfinalcopy")).toEqual([]);
  });

  it("ignores prose that merely names the command", () => {
    // Guidelines text tells the model not to call it; naming it is not calling
    // it, and an earlier draft of this matcher fired on the bare word.
    expect(finalCopyCommands("do not call iclrfinalcopy anywhere")).toEqual([]);
  });

  it("does not match a longer command with the same prefix", () => {
    expect(finalCopyCommands("\\iclrfinalcopyx")).toEqual([]);
  });
});

describe("anonymity_preserved", () => {
  function workspaceWith(templateTex: string, manuscript: string): string {
    const ws = scratchDir("po-anon-");
    mkdirSync(join(ws, "template"), { recursive: true });
    writeFileSync(join(ws, "template", "template.tex"), templateTex);
    writeFileSync(join(ws, "draft.tex"), manuscript);
    return ws;
  }

  it("passes when the manuscript keeps the template's review option", () => {
    const ws = workspaceWith("\\usepackage[review]{cvpr}", "\\usepackage[review]{cvpr}");
    expect(validators.anonymityPreserved(ws, "draft.tex").passed).toBe(true);
  });

  it("fails when the manuscript drops the review option", () => {
    const ws = workspaceWith("\\usepackage[review]{cvpr}", "\\usepackage{cvpr}");
    const check = validators.anonymityPreserved(ws, "draft.tex");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("review");
    expect(check.detail).toContain("cvpr");
  });

  it("fails when the manuscript stops loading the venue style at all", () => {
    const ws = workspaceWith("\\usepackage[review]{cvpr}", "\\usepackage{graphicx}");
    const check = validators.anonymityPreserved(ws, "draft.tex");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("does not load cvpr");
  });

  it("fails when the manuscript adds a camera-ready switch the template lacks", () => {
    const ws = workspaceWith(
      "\\usepackage{iclr2025_conference}",
      "\\usepackage{iclr2025_conference}\n\\iclrfinalcopy",
    );
    const check = validators.anonymityPreserved(ws, "draft.tex");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("\\iclrfinalcopy");
  });

  it("asserts nothing about a template with no anonymity mechanism", () => {
    // Nature Portfolio is single-anonymous, so real author names are correct
    // there. A check that demanded anonymity everywhere would be wrong.
    const ws = workspaceWith(
      "\\usepackage{natureportfolio}",
      "\\usepackage{natureportfolio}\n\\author{A Real Name}",
    );
    expect(validators.anonymityPreserved(ws, "draft.tex").passed).toBe(true);
  });

  it("passes when there is no template.tex to compare against", () => {
    const ws = scratchDir("po-anon-");
    mkdirSync(join(ws, "template"), { recursive: true });
    writeFileSync(join(ws, "draft.tex"), "\\usepackage{cvpr}");
    expect(validators.anonymityPreserved(ws, "draft.tex").passed).toBe(true);
  });

  it("reports a missing manuscript rather than passing it", () => {
    const ws = workspaceWith("\\usepackage[review]{cvpr}", "unused");
    const check = validators.anonymityPreserved(ws, "absent.tex");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("absent.tex");
  });
});

/**
 * The end-to-end assertion for this fix: what a reviewer would actually see on
 * page one. Model-free, so it belongs in the suite rather than in an
 * acceptance run.
 */
describe("bundled templates render the right identity block", () => {
  const EXPECTATIONS = [
    { id: "cvpr2025", mustContain: "Anonymous", mustNotContain: "Ambitious" },
    { id: "iclr2025", mustContain: "Anonymous", mustNotContain: "Ambitious" },
    { id: "nature-portfolio", mustContain: null, mustNotContain: "Ambitious" },
  ] as const;

  for (const { id, mustContain, mustNotContain } of EXPECTATIONS) {
    it(`${id} prints no fabricated author identity`, async () => {
      const adapter = templateAdapter(id);
      if (adapter?.source.kind !== "bundled") throw new Error(`${id} is not bundled`);

      const dir = join(scratchDir("po-anon-smoke-"), id);
      cpSync(join(templateRoot(), adapter.source.directory), dir, { recursive: true });
      copyFileSync(join(dir, "template.tex"), join(dir, "smoke.tex"));
      const built = await compileLatex({ cwd: dir, jobName: "smoke" });
      expect(built.ok).toBe(true);
      expect(built.pdf).not.toBeNull();

      const { stdout } = await execa("pdftotext", [built.pdf as string, "-"], {
        timeout: 60_000,
      });
      expect(stdout).not.toContain(mustNotContain);
      expect(stdout).not.toContain("researcher@institute.ai");
      expect(stdout).not.toContain("123 AI Avenue");
      if (mustContain) expect(stdout).toContain(mustContain);
    }, 60_000);
  }
});
