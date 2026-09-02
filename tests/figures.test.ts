import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPythonCode,
  lastTraceback,
  plottingAvailable,
  renderFigure,
  suspiciousPaths,
} from "../src/figures.js";
import { scratchDir } from "./fixtures.js";

/**
 * These run real matplotlib. That is the point: the failure this module exists
 * to catch -- a script that exits 0 and writes an empty canvas -- cannot be
 * reproduced with a stub, because the stub would have to decide the very thing
 * under test.
 */

function work(name: string): string {
  return join(scratchDir("po-fig-"), name);
}

const PLOT = [
  "import matplotlib",
  "import matplotlib.pyplot as plt",
  "plt.plot([1, 2, 3], [4, 5, 6])",
  'plt.savefig("out.pdf", bbox_inches="tight", dpi=300)',
].join("\n");

describe("extractPythonCode", () => {
  it("unwraps a ```python fence", () => {
    expect(extractPythonCode("prose\n```python\nx = 1\n```\nmore")).toBe("x = 1");
  });

  it("unwraps a bare fence, which the Python's regex missed", () => {
    // paper_banana_utils.py:301 matched only ```python, so a bare fence was
    // handed to the interpreter with its backticks attached and failed as a
    // syntax error that looked like bad code generation.
    expect(extractPythonCode("```\nx = 1\n```")).toBe("x = 1");
  });

  it("passes unfenced code through untouched", () => {
    expect(extractPythonCode("x = 1")).toBe("x = 1");
  });
});

describe("suspiciousPaths", () => {
  it("flags an escape from the working directory", () => {
    expect(suspiciousPaths('plt.savefig("../../out.pdf")')).toContain(
      "a parent-directory path (`../`)",
    );
  });

  it("flags an absolute savefig target", () => {
    expect(suspiciousPaths('plt.savefig("/tmp/out.pdf")')).toContain(
      "an absolute savefig path",
    );
  });

  it("flags a network fetch, since the script must be self-contained", () => {
    expect(suspiciousPaths("import urllib.request")).toContain("a network request");
  });

  it("passes an ordinary relative savefig", () => {
    expect(suspiciousPaths(PLOT)).toEqual([]);
  });
});

describe("lastTraceback", () => {
  it("keeps the exception rather than the matplotlib frames above it", () => {
    const stderr = [
      "Traceback (most recent call last):",
      ...Array.from({ length: 30 }, (_, at) => `  File "frame${at}.py", line ${at}`),
      "ValueError: x and y must be the same size",
    ].join("\n");
    expect(lastTraceback(stderr)).toContain("ValueError: x and y must be the same size");
  });

  it("says so plainly when there is no output at all", () => {
    expect(lastTraceback("")).toBe("no error output");
  });
});

describe("renderFigure", () => {
  it("renders a real figure and reports its path and size", async () => {
    const result = await renderFigure({ figureId: "f1", code: PLOT, workDir: work("w1") });
    expect(result.ok).toBe(true);
    expect(result.imagePath).toMatch(/out\.pdf$/);
    expect(result.bytes).toBeGreaterThan(1024);
    expect(result.error).toBeNull();
  }, 60_000);

  it("turns a crash into the exception text, not a thrown error", async () => {
    // A failed figure is data the caller remediates; one bad script must not
    // abort a stage the other figures can still complete.
    const result = await renderFigure({
      figureId: "f2",
      code: 'raise ValueError("mismatched series")',
      workDir: work("w2"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mismatched series");
  }, 60_000);

  it("catches a script that runs cleanly but saves nothing", async () => {
    const result = await renderFigure({
      figureId: "f3",
      code: "import matplotlib.pyplot as plt\nplt.plot([1], [1])",
      workDir: work("w3"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("saved no image");
    // The detail is the repair instruction, so it must name the exact call.
    expect(result.error).toContain('plt.savefig("f3.pdf"');
  }, 60_000);

  it("rejects an empty canvas, which passes every other check", async () => {
    // The real defect: plt.close() before savefig produces a valid, tiny file
    // that exists, satisfies figure_coverage, and prints as a blank rectangle.
    const result = await renderFigure({
      figureId: "f4",
      code: [
        "import matplotlib.pyplot as plt",
        "with open('out.png', 'wb') as fh:",
        "    fh.write(b'\\x89PNG\\r\\n\\x1a\\n')",
      ].join("\n"),
      workDir: work("w4"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty canvas");
  }, 60_000);

  it("refuses a script that reaches outside its directory, before running it", async () => {
    const dir = work("w5");
    const result = await renderFigure({
      figureId: "f5",
      code: 'import urllib.request\nplt.savefig("/etc/evil.pdf")',
      workDir: dir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network request");
  }, 60_000);

  it("refuses an empty script rather than running python on nothing", async () => {
    const result = await renderFigure({ figureId: "f6", code: "", workDir: work("w6") });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rebuilds the directory, so a previous attempt cannot be mistaken for this one", async () => {
    // Without this, a retry whose script fails would still find the earlier
    // attempt's image and report success.
    const dir = work("w7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stale.pdf"), "x".repeat(5000));

    const result = await renderFigure({
      figureId: "f7",
      code: "import matplotlib.pyplot as plt\nplt.plot([1], [1])",
      workDir: dir,
    });
    expect(result.ok).toBe(false);
    expect(readdirSync(dir)).not.toContain("stale.pdf");
  }, 60_000);
});

describe("plottingAvailable", () => {
  it("reports the matplotlib version when it can render", async () => {
    const probe = await plottingAvailable();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/matplotlib \d/);
  }, 60_000);
});
