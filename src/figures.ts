import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Controller-owned execution of model-written matplotlib scripts.
 *
 * The agent writes a script; the CONTROLLER runs it. That split is the point:
 * the agent keeps `bash: deny`, so a figure exists because a process produced
 * pixels, not because a model said it did -- the same rule the LaTeX build
 * follows. It is also strictly safer than the Python, which `exec()`d
 * model-generated code inside its own interpreter
 * (`paper_banana_utils.py:293-323`), where a stray `plt.rcdefaults()` or an
 * `os.remove` ran with the pipeline's full privileges and lifetime.
 *
 * The sandbox here is deliberately modest and honest about its limits: a
 * separate process, a scoped working directory, a wall-clock timeout, no
 * network environment, and a cleared matplotlib config. It is a guard against
 * a plausible accident -- a script that hangs, writes outside its directory,
 * or tries to fetch a font -- and not a boundary that would contain a
 * determined attacker. The real containment is that the script is generated
 * from the user's own materials by a model with no network access.
 */

/** Wall clock per script. Generous: a complex figure legitimately takes time. */
const RENDER_TIMEOUT_MS = 120_000;

/** Below this, a "rendered" file is an empty canvas or a truncated write. */
export const MIN_FIGURE_BYTES = 1024;

/** What a figure script is allowed to emit. */
const IMAGE_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"] as const;

export type FigureRoute = "code" | "text_to_image";

export function resolveFigureRoute(spec: {
  plot_type: "plot" | "diagram";
  render_route?: "auto" | FigureRoute;
}): FigureRoute {
  if (spec.render_route === "code" || spec.render_route === "text_to_image") {
    return spec.render_route;
  }
  return spec.plot_type === "diagram" ? "text_to_image" : "code";
}

export interface VisualReview {
  readonly passed: boolean;
  readonly suggestions: string;
}

/** Parse the visual critic's bounded JSON reply without trusting prose claims. */
export function parseVisualReview(text: string): VisualReview {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (typeof parsed.passed !== "boolean") throw new Error("missing passed");
    return {
      passed: parsed.passed,
      suggestions: typeof parsed.suggestions === "string" ? parsed.suggestions.trim() : "",
    };
  } catch {
    return {
      passed: false,
      suggestions: "visual critic returned invalid JSON; inspect the attached image and respond again",
    };
  }
}

export interface RenderRequest {
  readonly figureId: string;
  /** Python source, already unwrapped from any markdown fence. */
  readonly code: string;
  /** Directory the script runs in and writes to. Created if absent. */
  readonly workDir: string;
}

export interface RenderResult {
  readonly figureId: string;
  readonly ok: boolean;
  /** Absolute path to the produced image, null when nothing usable appeared. */
  readonly imagePath: string | null;
  readonly bytes: number;
  /** Actionable diagnosis; interpolated into a remediation prompt verbatim. */
  readonly error: string | null;
}

/**
 * Strip a markdown code fence, if the model wrapped its answer in one.
 *
 * Ported from `paper_banana_utils.py:301-302`, with one addition: the Python
 * matched only ```python, so a bare ``` fence -- which models emit often --
 * was passed to the interpreter with its backticks still attached and failed
 * with a syntax error that looked like bad code generation.
 */
export function extractPythonCode(text: string): string {
  const fenced = /```(?:python|py)?\s*\n([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Reject a script that reaches outside its own directory.
 *
 * Not a security boundary -- a determined script can defeat any regex -- but
 * these are the patterns a well-meaning model actually produces: an absolute
 * `savefig` path, a walk up out of the work directory, or a font download.
 * Catching them here turns a confusing partial failure into a clear message
 * the remediation prompt can act on.
 */
export function suspiciousPaths(code: string): string[] {
  const findings: string[] = [];
  if (/\.\.[\\/]/.test(code)) findings.push("a parent-directory path (`../`)");
  if (/savefig\s*\(\s*["']\//.test(code)) findings.push("an absolute savefig path");
  if (/\b(?:urllib|requests|urlopen|urlretrieve)\b/.test(code)) {
    findings.push("a network request");
  }
  if (/\bsubprocess\b|\bos\.system\b/.test(code)) findings.push("a subprocess call");
  return findings;
}

/**
 * Environment for a figure script.
 *
 * `MPLBACKEND=Agg` because there is no display and the default backend would
 * fail or block. `MPLCONFIGDIR` is scoped so a script cannot leave state in
 * the user's matplotlib config between runs. The proxy variables are cleared
 * rather than set: a plotting script has no business fetching anything, and an
 * inherited proxy is the usual reason one appears to hang.
 */
function renderEnv(workDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: join(workDir, ".mplconfig"),
    // Python imports workDir/sitecustomize.py before the generated script.
    // That hook disables the standard socket entry points even on hosts where
    // an OS network namespace is unavailable to an unprivileged process.
    PYTHONPATH: workDir,
  };
  for (const key of [
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
  ]) {
    delete env[key];
  }
  return env;
}

/** Images the script left behind, newest-looking first, ignoring scratch dirs. */
function producedImages(workDir: string): string[] {
  return readdirSync(workDir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => join(workDir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).size - statSync(a).size);
}

/**
 * Run one figure script and collect what it produced.
 *
 * Never throws: a failed figure is data the caller reports and remediates, in
 * the same spirit as `Check[]`. A single bad script must not abort a stage the
 * other figures can still complete.
 */
export async function renderFigure(request: RenderRequest): Promise<RenderResult> {
  const { figureId, workDir } = request;
  const code = extractPythonCode(request.code);

  if (!code) {
    return {
      figureId,
      ok: false,
      imagePath: null,
      bytes: 0,
      error: "the script was empty; expected Python that draws the figure and saves it",
    };
  }

  const suspicious = suspiciousPaths(code);
  if (suspicious.length > 0) {
    return {
      figureId,
      ok: false,
      imagePath: null,
      bytes: 0,
      error:
        `the script contains ${suspicious.join(" and ")}. Write a self-contained ` +
        "script that only saves into its own directory with a relative filename, " +
        "and that fetches nothing: embed the data as literals in the script.",
    };
  }

  // Rebuild the directory each time so a previous attempt's output cannot be
  // mistaken for this one's -- the same reasoning as the LaTeX build dir.
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const scriptPath = join(workDir, `${figureId}.py`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(workDir, "sitecustomize.py"),
    [
      "import socket",
      "def _paper_orchestra_network_disabled(*args, **kwargs):",
      "    raise RuntimeError('network disabled by PaperOrchestra')",
      "socket.create_connection = _paper_orchestra_network_disabled",
      "socket.getaddrinfo = _paper_orchestra_network_disabled",
      "socket.socket.connect = _paper_orchestra_network_disabled",
      "socket.socket.connect_ex = _paper_orchestra_network_disabled",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(scriptPath, code, "utf8");

  let stderr = "";
  try {
    // The script's basename, not `scriptPath`: `cwd` is already `workDir`, so a
    // path here would be resolved against it. When `workDir` is relative that
    // produced `<workDir>/<workDir>/<figureId>.py` and python3 could not open
    // its own script. Passing the basename is correct whatever `workDir` is,
    // and keeps host paths out of any error text the model is shown.
    const result = await execa("python3", [basename(scriptPath)], {
      cwd: workDir,
      env: renderEnv(workDir),
      timeout: RENDER_TIMEOUT_MS,
      reject: false,
    });
    stderr = result.stderr ?? "";

    if (result.exitCode !== 0) {
      return {
        figureId,
        ok: false,
        imagePath: null,
        bytes: 0,
        error: `the script exited ${result.exitCode}: ${lastTraceback(stderr)}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return {
        figureId,
        ok: false,
        imagePath: null,
        bytes: 0,
        error: "python3 is not on PATH, so no figure can be rendered",
      };
    }
    return {
      figureId,
      ok: false,
      imagePath: null,
      bytes: 0,
      error: `the script did not finish within ${RENDER_TIMEOUT_MS / 1000}s`,
    };
  }

  const images = producedImages(workDir);
  const best = images[0];
  if (!best) {
    const rasterOnly = readdirSync(workDir).some((name) =>
      [".png", ".jpg", ".jpeg"].some((ext) => name.toLowerCase().endsWith(ext)),
    );
    return {
      figureId,
      ok: false,
      imagePath: null,
      bytes: 0,
      error:
        (rasterOnly
          ? "the code-generation route must produce a PDF, but the script saved only a raster image. "
          : "the script ran without error but saved no PDF. ") +
        "End it with " +
        `plt.savefig("${figureId}.pdf", bbox_inches="tight", dpi=300) using a ` +
        "relative filename.",
    };
  }

  const bytes = statSync(best).size;
  if (bytes < MIN_FIGURE_BYTES) {
    return {
      figureId,
      ok: false,
      imagePath: best,
      bytes,
      error:
        `the saved image is only ${bytes} bytes, which means an empty canvas. ` +
        "Plot the data before saving, and do not call plt.close() or plt.clf() first.",
    };
  }

  return { figureId, ok: true, imagePath: best, bytes, error: null };
}

/**
 * The tail of a Python traceback: the exception line and a little context.
 *
 * The full traceback is mostly matplotlib internals. The final lines carry the
 * actual fault, and this text goes into a remediation prompt where brevity is
 * what makes it usable.
 */
export function lastTraceback(stderr: string, lines = 6): string {
  const meaningful = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return "no error output";
  return meaningful.slice(-lines).join(" | ").slice(0, 600);
}

/** Whether this machine can render figures at all. */
export async function plottingAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await execa(
      "python3",
      ["-c", "import matplotlib; print(matplotlib.__version__)"],
      { timeout: 30_000, reject: false },
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        detail:
          "python3 is present but matplotlib is not importable. Install it " +
          "(`pip install matplotlib`) or run without --use-plotting to use supplied figures.",
      };
    }
    return { ok: true, detail: `matplotlib ${result.stdout.trim()}` };
  } catch {
    return {
      ok: false,
      detail:
        "python3 is not on PATH, so figures cannot be rendered. Install Python with " +
        "matplotlib, or run without --use-plotting to use supplied figures.",
    };
  }
}

export const FIGURE_EXTENSIONS = IMAGE_EXTENSIONS;
export { RENDER_TIMEOUT_MS };
