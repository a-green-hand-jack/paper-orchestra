import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { discoverTemplate, proseDensity } from "../src/template-discovery.js";
import { UserFacingError } from "../src/errors.js";
import { scratchDir } from "./fixtures.js";

/** Build an input tree from a path -> contents map. */
function input(files: Record<string, string>): string {
  const dir = scratchDir("po-discover-");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const MAIN = [
  "\\documentclass{article}",
  "\\usepackage[preprint]{neurips_2025}",
  "\\begin{document}",
  "\\section{Introduction}",
  "\\section{Method}",
  "\\end{document}",
].join("\n");

/** A finished paper: the same class, but prose between the headings. */
const FINISHED = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Introduction}",
  "Deep networks have transformed vision. ".repeat(40),
  "\\section{Method}",
  "We propose a temporal adapter that reuses the frozen backbone. ".repeat(40),
  "\\end{document}",
].join("\n");

describe("main document vs fragment", () => {
  it("requires both markers, which is what separates a template from a table", () => {
    // Measured over 750 real .tex files: 274 carried both markers, 476 carried
    // neither, and none carried only one.
    const dir = input({
      "template.tex": MAIN,
      "tables/table_1.tex": "\\begin{tabular}{cc}a & b\\\\\\end{tabular}",
      "preamble.tex": "\\usepackage{amsmath}",
    });
    expect(discoverTemplate(dir)?.main).toBe("template.tex");
  });

  it("returns null when the input holds no LaTeX document at all", () => {
    // Not an error: this is the ordinary case that routes to a bundled venue.
    const dir = input({ "notes.md": "# Idea\n", "train.py": "x = 1\n" });
    expect(discoverTemplate(dir)).toBeNull();
  });
});

describe("choosing between documents", () => {
  it("prefers the template waiting to be filled over a finished paper", () => {
    // The one genuinely ambiguous real input had two main documents with the
    // SAME section count, where the template was the smaller file -- so
    // preferring the larger one picks wrong every time.
    const dir = input({
      "template.tex": MAIN,
      "code/tex/paper.tex": FINISHED,
      "code/pyproject.toml": "[project]\nname='x'\n",
    });
    expect(discoverTemplate(dir)?.main).toBe("template.tex");
  });

  it("ignores a template shipped by a package vendored into the input", () => {
    // A dependency can vendor an entire paper-writing tool whose own venue
    // templates are also empty files named template.tex.
    const dir = input({
      "materials/kit/template.tex": MAIN,
      "materials/kit/neurips_2025.sty": "% style\n",
      "tool/requirements.txt": "requests\n",
      "tool/templates/cvpr2025/template.tex": MAIN,
      "tool/templates/cvpr2025/cvpr.sty": "% other style\n",
    });
    const found = discoverTemplate(dir);
    expect(found?.main).toBe("materials/kit/template.tex");
    expect(found?.templateFiles.some((t) => t.startsWith("tool/"))).toBe(false);
  });

  it("does not penalise a manifest at the input root, which is the normal case", () => {
    // Users point us at their research repository, and those have manifests.
    const dir = input({
      "pyproject.toml": "[project]\nname='mine'\n",
      "paper/template.tex": MAIN,
    });
    expect(discoverTemplate(dir)?.main).toBe("paper/template.tex");
  });

  it("refuses to guess between two equally plausible templates", () => {
    // Deciding a paper's format by a scoring tie is worse than asking.
    const dir = input({ "one/template.tex": MAIN, "two/template.tex": MAIN });
    expect(() => discoverTemplate(dir)).toThrow(UserFacingError);
    expect(() => discoverTemplate(dir)).toThrow(/--template/);
  });
});

describe("prose density", () => {
  it("separates an empty template from a written paper by two orders of magnitude", () => {
    expect(proseDensity(MAIN)).toBeLessThan(100);
    expect(proseDensity(FINISHED)).toBeGreaterThan(400);
  });

  it("does not divide by zero on a document with no sections", () => {
    expect(proseDensity("\\begin{document}Hello\\end{document}")).toBeGreaterThan(0);
  });
});

describe("attribution", () => {
  it("claims a dependency by the name the template asks for, wherever it sits", () => {
    // One real input's \documentclass resolves to a .cls buried inside a
    // vendored source tree. Searching by name finds it; by location, never.
    const dir = input({
      "materials/template.tex": "\\documentclass{oup-authoring}\n\\begin{document}\\end{document}",
      "materials/code/tex/oup-authoring.cls": "% class\n",
      "materials/code/pyproject.toml": "[project]\nname='x'\n",
    });
    expect(discoverTemplate(dir)?.templateFiles).toContain("materials/code/tex/oup-authoring.cls");
  });

  it("finds a style file in a sibling directory, which one input makes possible", () => {
    const dir = input({
      "materials/template.tex": MAIN,
      "materials/research_overview.md": "# Idea\n",
      "texmf/neurips_2025.sty": "% style\n",
    });
    const found = discoverTemplate(dir);
    expect(found?.templateFiles).toContain("texmf/neurips_2025.sty");
    expect(found?.templateFiles).not.toContain("materials/research_overview.md");
  });

  it("does not claim a style file nothing asked for", () => {
    const dir = input({
      "template.tex": MAIN,
      "leftovers/unused.sty": "% nobody loads this\n",
    });
    expect(discoverTemplate(dir)?.templateFiles).not.toContain("leftovers/unused.sty");
  });

  it("claims the fragments the template inputs", () => {
    const dir = input({
      "template.tex": "\\documentclass{article}\n\\input{preamble}\n\\begin{document}\\end{document}",
      "preamble.tex": "\\usepackage{amsmath}\n",
    });
    expect(discoverTemplate(dir)?.templateFiles).toContain("preamble.tex");
  });

  it("leaves the author's bibliography alone when the template shares its directory", () => {
    // The expensive mistake: a bibliography reaching source/references.bib
    // makes the run skip paid retrieval and cite whatever it holds. Real
    // inputs put a 189 KB author bibliography beside template.tex.
    const dir = input({
      "materials/template.tex": MAIN,
      "materials/references.bib": "@article{real2024, title={The author's own}}\n",
      "materials/research_overview.md": "# Idea\n",
      "texmf/neurips_2025.sty": "% style\n",
    });
    const found = discoverTemplate(dir);
    expect(found?.dedicatedDirectory).toBe(false);
    expect(found?.templateFiles).not.toContain("materials/references.bib");
  });

  it("claims the venue's stub bibliography when the template has its own directory", () => {
    const dir = input({
      "materials/idea_sparse.md": "# Idea\n",
      "materials/kit/template.tex": MAIN,
      "materials/kit/neurips_2025.sty": "% style\n",
      "materials/kit/references.bib": "@article{example, title={Venue example}}\n",
      "materials/kit/guidelines.md": "# Eleven pages\n",
    });
    const found = discoverTemplate(dir);
    expect(found?.dedicatedDirectory).toBe(true);
    expect(found?.templateFiles).toContain("materials/kit/references.bib");
    expect(found?.templateFiles).toContain("materials/kit/guidelines.md");
    expect(found?.templateFiles).not.toContain("materials/idea_sparse.md");
  });
});

/**
 * The corpus this was designed against, when it happens to be on the machine.
 *
 * Synthetic fixtures prove each heuristic in isolation; only the corpus proves
 * they do not overfit, so it runs when present rather than being skipped for
 * convenience.
 */
const CORPUS = "/home/user/dev/paperbench-release-v0.4.0";
describe.skipIf(!existsSync(CORPUS))("corpus replay", () => {
  it("finds the intended template in every task input", () => {
    const wrong: string[] = [];
    let total = 0;
    for (const config of readdirSync(CORPUS)) {
      for (const task of readdirSync(join(CORPUS, config))) {
        const env = join(CORPUS, config, task, "environment");
        if (!existsSync(env)) continue;
        total += 1;
        try {
          const main = discoverTemplate(env)?.main ?? "(none)";
          if (!/^materials\/(conference_template\/)?template\.tex$/.test(main)) {
            wrong.push(`${config}/${task}: ${main}`);
          }
        } catch (error) {
          wrong.push(`${config}/${task}: threw ${(error as Error).message.slice(0, 60)}`);
        }
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(wrong).toEqual([]);
  }, 300_000);
});
