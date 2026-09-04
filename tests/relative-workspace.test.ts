import { existsSync, mkdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderFigure } from "../src/figures.js";

/**
 * The workspace path is relative in the default configuration: `-o` defaults to
 * `./po-run-<timestamp>`, and the documented workflow runs from the materials
 * directory. Anything that hands a workspace-derived path to a subprocess while
 * also setting `cwd` inside the workspace has to survive that.
 *
 * The relative path here deliberately has no `../` segment. A path like
 * `../../tmp/x/fig.py` resolved against `/tmp/x` lands back on the right file
 * by accident, so a tmpdir-based test cannot see this bug at all -- which is
 * why the existing figure tests, which build their own absolute directories,
 * did not catch it.
 */
const SCRATCH = resolve(process.cwd(), ".vitest", "relative-workspace");

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("renderFigure with a workspace-relative work directory", () => {
  it("runs the script it just wrote", async () => {
    mkdirSync(SCRATCH, { recursive: true });
    const workDir = relative(process.cwd(), resolve(SCRATCH, "figures", "fig_demo"));
    expect(workDir.startsWith("..")).toBe(false);

    const result = await renderFigure({
      figureId: "fig_demo",
      workDir,
      code: [
        "import matplotlib",
        "matplotlib.use('Agg')",
        "import matplotlib.pyplot as plt",
        "fig, ax = plt.subplots(figsize=(3, 2))",
        "ax.plot([1, 2, 3], [43.43, 54.58, 49.01], marker='o')",
        "ax.set_xlabel('setting')",
        "ax.set_ylabel('J')",
        "fig.savefig('fig_demo.pdf', bbox_inches='tight', dpi=300)",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.imagePath).not.toBeNull();
    expect(existsSync(result.imagePath as string)).toBe(true);
    expect(result.bytes).toBeGreaterThan(1024);
  }, 60_000);

  it("reports a script error rather than a missing-file error", async () => {
    // Before the fix every failure looked like `python3: can't open file`,
    // which hid the real diagnosis and was fed back to the model as if the
    // script were at fault.
    mkdirSync(SCRATCH, { recursive: true });
    const workDir = relative(process.cwd(), resolve(SCRATCH, "figures", "fig_broken"));

    const result = await renderFigure({
      figureId: "fig_broken",
      workDir,
      code: "raise ValueError('deliberate')",
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error).not.toContain("can't open file");
    expect(result.error).toContain("ValueError");
  }, 60_000);
});
