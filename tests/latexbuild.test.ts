import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileLatex,
  extractLatexErrors,
  extractOverfullBoxes,
  pdfPageCount,
  renderPdfPages,
  stageBuildDir,
  unwrapLog,
} from "../src/latexbuild.js";
import { paths } from "../src/paths.js";
import { scratchDir, prepared } from "./fixtures.js";

const MINIMAL_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello from paper-orchestra.",
  "\\end{document}",
].join("\n");

describe("extractLatexErrors", () => {
  it("keeps error lines and drops font chatter", () => {
    // A pdflatex log is thousands of mostly irrelevant lines; feeding it whole
    // into a remediation prompt buries the actual fault.
    const log = [
      "This is pdfTeX, Version 3.14",
      "LaTeX Font Info:    Trying to load font information for OT1+ptm",
      "! Undefined control sequence.",
      "l.12 \\badcommand",
      "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 9.",
    ].join("\n");
    const errors = extractLatexErrors(log);
    expect(errors.some((e) => e.includes("Undefined control sequence"))).toBe(true);
    expect(errors.some((e) => e.includes("fig:missing"))).toBe(true);
    expect(errors.some((e) => e.includes("Font Info"))).toBe(false);
  });

  it("attaches the location line that follows a bang", () => {
    const errors = extractLatexErrors("! Undefined control sequence.\nl.12 \\badcommand");
    expect(errors[0]).toContain("l.12");
  });

  it("deduplicates an error repeated across passes", () => {
    const line = "LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 9.";
    expect(extractLatexErrors([line, line, line].join("\n"))).toHaveLength(1);
  });

  it("returns nothing for a clean log", () => {
    expect(extractLatexErrors("This is pdfTeX\nOutput written on x.pdf (8 pages)")).toEqual([]);
  });

  it("bounds how many errors it reports", () => {
    const log = Array.from({ length: 100 }, (_, i) => `! Error number ${i}.`).join("\n");
    expect(extractLatexErrors(log).length).toBeLessThanOrEqual(25);
  });
});

describe("compileLatex", () => {
  it("compiles a minimal document and reports the page count", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(join(dir, "manuscript.tex"), MINIMAL_TEX);
    const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(result.ok).toBe(true);
    expect(result.pdf).not.toBeNull();
    expect(result.pages).toBe(1);
  });

  it("reports failure with actionable errors rather than throwing", async () => {
    // The controller turns these into a remediation prompt, so a broken
    // document must come back as data.
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      "\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}",
    );
    const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).toMatch(/Undefined control sequence/);
  });

  it("does not inherit the host TeX tree", async () => {
    // A build that depends on TEXINPUTS is not reproducible on another machine.
    const dir = scratchDir("po-tex-");
    writeFileSync(join(dir, "manuscript.tex"), MINIMAL_TEX);
    process.env.TEXINPUTS = "/nonexistent/should/be/ignored:";
    try {
      const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.TEXINPUTS;
    }
  });
});

describe("pdfPageCount", () => {
  it("returns null for something that is not a PDF", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(join(dir, "not.pdf"), "definitely not a pdf");
    await expect(pdfPageCount(join(dir, "not.pdf"))).resolves.toBeNull();
  });

  it("counts pages that are not visible in the raw bytes", async () => {
    // pdflatex stores page objects in compressed object streams, so a regex
    // over the file contents finds nothing.
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      "\\documentclass{article}\\begin{document}One\\newpage Two\\newpage Three\\end{document}",
    );
    const built = await compileLatex({ cwd: dir, jobName: "manuscript" });
    await expect(pdfPageCount(built.pdf as string)).resolves.toBe(3);
  });
});

describe("stageBuildDir", () => {
  it("copies template support files but not the template's own main file", async () => {
    // The manuscript replaces template.tex; copying both would compile the
    // placeholder instead of the paper.
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    const buildDir = stageBuildDir(workspace, tex);
    expect(existsSync(join(buildDir, "cvpr.sty"))).toBe(true);
    expect(existsSync(join(buildDir, "template.tex"))).toBe(false);
    expect(existsSync(join(buildDir, "manuscript.tex"))).toBe(true);
  });

  it("brings figures along but leaves info.json behind", async () => {
    const { workspace } = await prepared();
    const figures = join(paths(workspace).brainManuscript, "figures");
    mkdirSync(figures, { recursive: true });
    writeFileSync(join(figures, "overview.png"), "png");
    writeFileSync(join(figures, "info.json"), "[]");
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    const buildDir = stageBuildDir(workspace, tex);
    expect(existsSync(join(buildDir, "figures", "overview.png"))).toBe(true);
    expect(existsSync(join(buildDir, "figures", "info.json"))).toBe(false);
  });

  it("leaves the digest-locked template untouched", async () => {
    const { workspace, state } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    stageBuildDir(workspace, tex);
    const { computeLockDigests } = await import("../src/state/store.js");
    expect(computeLockDigests(workspace).templateDigest).toBe(state.template_digest);
  });
});

describe("renderPdfPages", () => {
  it("renders each page to a png for visual review", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      "\\documentclass{article}\\begin{document}One\\newpage Two\\end{document}",
    );
    const built = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(built.pdf).not.toBeNull();
    const pages = await renderPdfPages(built.pdf as string, join(dir, "renders"));
    expect(pages.length).toBe(2);
  });
});

describe("stageBuildDir repeatability", () => {
  it("can stage twice, despite imported templates being read-only", async () => {
    // Regression: template files are imported at mode 0444, so copying over a
    // surviving copy from an earlier stage failed with EACCES. The refinement
    // stage died on exactly this after section_writing had already built.
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    stageBuildDir(workspace, tex);
    expect(() => stageBuildDir(workspace, tex)).not.toThrow();
  });

  it("does not carry stale build products between stages", async () => {
    // A leftover .aux/.bbl can resolve references against the previous
    // manuscript's bibliography and report success, which is worse than failing.
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    const buildDir = stageBuildDir(workspace, tex);
    writeFileSync(join(buildDir, "manuscript.aux"), "\\citation{stale2020key}");
    stageBuildDir(workspace, tex);
    expect(existsSync(join(buildDir, "manuscript.aux"))).toBe(false);
  });

  it("compiles cleanly on a restaged directory", async () => {
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    stageBuildDir(workspace, tex);
    const buildDir = stageBuildDir(workspace, tex);
    const result = await compileLatex({ cwd: buildDir, jobName: "manuscript" });
    expect(result.ok).toBe(true);
  });
});

describe("natbib and wrapped-log handling", () => {
  it("catches reference warnings emitted by a package, not just LaTeX core", () => {
    const log = "Package natbib Warning: Reference `fig:one' on page 1 undefined on input line 32.";
    expect(extractLatexErrors(log).join(" ")).toContain("fig:one");
  });

  it("ignores pass-1 citation warnings, which every healthy build produces", () => {
    // The first pdflatex pass necessarily runs before bibtex, so a manuscript
    // whose bibliography resolves completely still logs one warning per
    // citation -- 25 of them on a real 4-page run. Treating those as failures
    // would reject every correct build.
    const log = "Package natbib Warning: Citation `Zhu2021Deep' on page 1 undefined on input line 32.";
    expect(extractLatexErrors(log)).toEqual([]);
  });

  it("rejoins a warning that TeX hard-wrapped at 79 columns", () => {
    const log = [
      "Package natbib Warning: Reference `sec:experiments-with-a-long-label' on page 1 u",
      "ndefined on input line 32.",
    ].join("\n");
    expect(extractLatexErrors(log).join(" ")).toMatch(/undefined on input line 32/);
  });

  it("does not glue two separate messages together", () => {
    const log = [
      "Package natbib Warning: Reference `A' on page 1 undefined on input line 3000000",
      "Package natbib Warning: Reference `B' on page 2 undefined on input line 4.",
    ].join("\n");
    expect(unwrapLog(log)).toHaveLength(2);
  });

  it("catches bibtex's missing-database-entry warning", () => {
    const log = 'Warning--I didn\'t find a database entry for "Zhu2021Deep"';
    expect(extractLatexErrors(log).join(" ")).toContain("Zhu2021Deep");
  });
});

describe("generated bibliography reaches the build", () => {
  it("overwrites the template's stub references.bib", async () => {
    // Templates ship a placeholder references.bib. Copying only the template's
    // copy makes bibtex read the stub, emit "didn't find a database entry" for
    // every key, write an empty .bbl, and render [?] for all 84 citations --
    // while every artifact on disk looks correct.
    const { workspace } = await prepared();
    const generated = join(workspace, ".brain", "raw", "references.bib");
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(generated, "@article{real2024a, title={Real}, author={A B}, year={2024}}\n");

    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    const buildDir = stageBuildDir(workspace, tex);
    expect(readFileSync(join(buildDir, "references.bib"), "utf8")).toContain("real2024a");
  });

  it("still stages when no bibliography has been generated yet", async () => {
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    expect(() => stageBuildDir(workspace, tex)).not.toThrow();
  });
});

describe("rendered citation marks", () => {
  it("counts nothing for a clean document", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(join(dir, "manuscript.tex"), MINIMAL_TEX);
    const built = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(built.unresolvedCitationMarks).toBe(0);
  });

  it("counts a citation that resolved to nothing", async () => {
    // The guarantee that does not depend on log formats: it inspects what the
    // reader would actually see.
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Text \\cite{ghost2024z} more.",
        "\\bibliographystyle{plain}",
        "\\bibliography{empty}",
        "\\end{document}",
      ].join("\n"),
    );
    writeFileSync(join(dir, "empty.bib"), "");
    const built = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(built.unresolvedCitationMarks).toBeGreaterThan(0);
  });
});

describe("build directory is writable scratch", () => {
  it("stages read-only template files as writable copies", async () => {
    // copyFileSync preserves mode, and imported templates are 0444, so a plain
    // copy makes every staged file read-only and the next overwrite fails.
    const { workspace } = await prepared();
    const tex = join(scratchDir("po-src-"), "draft.tex");
    writeFileSync(tex, MINIMAL_TEX);
    const buildDir = stageBuildDir(workspace, tex);
    expect(statSync(join(buildDir, "cvpr.sty")).mode & 0o200).toBeGreaterThan(0);
  });
});

describe("diagnostics come from the final pass", () => {
  it("reports no errors for a document whose refs resolve on a later pass", async () => {
    // pdflatex overwrites .log each pass, so the final file holds the finished
    // state. Reading concatenated stdout instead made the error list depend on
    // how far the build got: a healthy document still logs one
    // Reference-undefined per \ref on pass 1.
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{One}\\label{sec:one}",
        "See \\ref{sec:one} and \\ref{sec:two}.",
        "\\newpage\\section{Two}\\label{sec:two}",
        "\\end{document}",
      ].join("\n"),
    );
    const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("still reports a reference that never resolves", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      "\\documentclass{article}\\begin{document}See \\ref{sec:ghost}.\\end{document}",
    );
    const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(result.errors.join(" ")).toContain("sec:ghost");
  });
});

describe("extractOverfullBoxes", () => {
  it("reads the width and source lines TeX reports", () => {
    const log = "Overfull \\hbox (40.97647pt too wide) in paragraph at lines 108--116";
    expect(extractOverfullBoxes(log)).toEqual([{ points: 40.97647, lines: "108--116" }]);
  });

  it("orders worst first, so the report leads with the real damage", () => {
    const log = [
      "Overfull \\hbox (3.1pt too wide) in paragraph at lines 10--12",
      "Overfull \\hbox (40.9pt too wide) in paragraph at lines 108--116",
    ].join("\n");
    expect(extractOverfullBoxes(log).map((b) => b.points)).toEqual([40.9, 3.1]);
  });

  it("finds nothing in a clean log", () => {
    expect(extractOverfullBoxes("This is pdfTeX\nOutput written on x.pdf")).toEqual([]);
  });

  it("detects a genuinely too-wide table end to end", async () => {
    const dir = scratchDir("po-tex-");
    writeFileSync(
      join(dir, "manuscript.tex"),
      [
        "\\documentclass[twocolumn]{article}",
        "\\begin{document}",
        "\\begin{table}[t]\\begin{tabular}{@{}llllllllll@{}}",
        Array.from({ length: 10 }, () => "AVeryWideHeaderCell").join(" & ") + " \\\\",
        "\\end{tabular}\\end{table}",
        "Body text.",
        "\\end{document}",
      ].join("\n"),
    );
    const result = await compileLatex({ cwd: dir, jobName: "manuscript" });
    expect(result.overfullBoxes.length).toBeGreaterThan(0);
    expect(result.overfullBoxes[0]?.points).toBeGreaterThan(10);
  });
});
