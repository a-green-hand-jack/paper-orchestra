import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareWorkspace } from "../src/commands/prepare.js";
import { prepareOptions } from "./fixtures.js";
import { walkFiles } from "../src/files.js";
import { paths, SOURCE_DIR } from "../src/paths.js";
import { suppliedBibliography } from "../src/bibliography.js";
import { validators } from "../src/validation.js";
import { readRunState } from "../src/state/store.js";
import { scratchDir } from "./fixtures.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const D = "/home/user/dev/paperbench-release-v0.4.0";

async function single(input: string) {
  const opts = { ...prepareOptions(), rawMaterials: input, templateDir: null };
  const result = await prepareWorkspace(opts);
  return { workspace: opts.workspace, p: paths(opts.workspace), state: result.state };
}

describe("single input, real task", () => {
  it("pwb-0001: author bib stays in source, style file lands in template", async () => {
    const { workspace, p, state } = await single(`${D}/paperwrite-bench-short/pwb-0001/environment`);
    console.log("template/:", walkFiles(p.template));
    console.log("venue:", state.scope.venue, "| selection:", state.scope.template_selection);
    expect(walkFiles(p.template).sort()).toEqual(["neurips_2025.sty", "template.tex"]);
    // The 189 KB author bibliography must remain material.
    expect(existsSync(join(workspace, SOURCE_DIR, "materials", "references.bib"))).toBe(true);
    expect(suppliedBibliography(workspace)).toBeNull();
    expect(readFileSync(join(p.template, "template.tex"), "utf8")).toContain("neurips_2025");
  }, 180_000);

  it("pwbw-0001: the whole kit lands, and the venue stub does not become the author's", async () => {
    const { workspace, p } = await single(`${D}/paperwritingbench-sparse-plotoff/pwbw-0001/environment`);
    const t = walkFiles(p.template).sort();
    console.log("template/:", t);
    expect(t).toContain("template.tex");
    expect(t).toContain("cvpr.sty");
    expect(t).toContain("preamble.tex");
    expect(t).toContain("references.bib");
    expect(t).toContain("guidelines.md");
    expect(suppliedBibliography(workspace)).toBeNull();
    // The vendored tool's own templates must not be in there.
    expect(t.some((x) => x.includes("iclr2025"))).toBe(false);
  }, 180_000);

  it("lspr-0016: the class file buried in code/ is flattened next to the template", async () => {
    const { p } = await single(`${D}/lifesci-paperrecon-short/lspr-0016/environment`);
    console.log("template/:", walkFiles(p.template));
    expect(walkFiles(p.template)).toContain("oup-authoring-template.cls");
  }, 180_000);

  it("digest locks hold over the derived template tree", async () => {
    const { workspace } = await single(`${D}/paperwrite-bench-short/pwb-0001/environment`);
    const { verifyLocks } = await import("../src/state/store.js");
    expect(() => verifyLocks(workspace, readRunState(workspace))).not.toThrow();
  }, 180_000);

  it("a template with no style file at all still passes compatibility", async () => {
    const dir = scratchDir("po-plain-");
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    put("notes.md", "# Idea\n\nA thing.\n");
    put("paper.tex", "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\end{document}\n");
    const { workspace, p } = await single(dir);
    expect(walkFiles(p.template)).toEqual(["template.tex"]);
    writeFileSync(
      join(workspace, ".brain", "manuscript", "raw_draft.tex"),
      "\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n",
    );
    // The style-file count used to gate this, and failed at section_writing --
    // after most of the spend -- for a template that is simply standard.
    const check = validators.templateCompatibility(workspace, ".brain/manuscript/raw_draft.tex");
    expect(check.passed).toBe(true);
    // The documentclass comparison, which is what the check is really for,
    // still runs.
    writeFileSync(
      join(workspace, ".brain", "manuscript", "raw_draft.tex"),
      "\\documentclass{report}\n\\begin{document}\nBody.\n\\end{document}\n",
    );
    const mismatch = validators.templateCompatibility(
      workspace,
      ".brain/manuscript/raw_draft.tex",
    );
    expect(mismatch.passed).toBe(false);
    expect(mismatch.detail).toContain("report");
  }, 180_000);
});
