import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { execa } from "execa";
import { CandidatesSchema, OutlineSchema } from "./artifacts.js";
import { suppliedBibliography } from "./bibliography.js";
import { UserFacingError } from "./errors.js";
import { readJson } from "./files.js";
import { plottingAvailable, resolveFigureRoute } from "./figures.js";
import { IMAGE_ADAPTER_ENV, textToImageCapability } from "./imagegen.js";
import { ARTIFACTS, BRIEF_FILE } from "./paths.js";
import { initialRetrievalSatisfied } from "./literature-controller.js";
import type { RunState } from "./state/schema.js";

/** Inspect executable permissions without running an adapter or a paid operation. */
export function executableAvailable(binary: string): boolean {
  const candidates = binary.includes("/")
    ? [binary]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, binary));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/** Non-billable checks to call before creating the OpenCode runtime. */
export async function preflightRun(
  workspace: string,
  state: RunState,
  allowLkmSpend: boolean,
): Promise<void> {
  const pending = new Set(state.scope.plan.filter((id) => state.stages[id].status !== "completed"));
  if (pending.size === 0) return;
  const requireTool = (binary: string): void => {
    if (!executableAvailable(binary)) {
      throw new UserFacingError(`preflight: executable \`${binary}\` is required by unfinished stages but is not available on PATH`);
    }
  };
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new UserFacingError("preflight: Node.js >=20 is required");
  }
  requireTool("opencode");
  requireTool("git");
  if (pending.has("section_writing") || pending.has("refinement")) {
    for (const binary of ["pdflatex", "bibtex", "pdftotext"]) requireTool(binary);
  }
  if (pending.has("refinement")) {
    requireTool("pdftoppm");
    requireTool("pdfinfo");
  }

  let outline: ReturnType<typeof OutlineSchema.parse> | null = null;
  if (existsSync(join(workspace, ARTIFACTS.outline))) {
    try {
      const parsed = OutlineSchema.safeParse(readJson(join(workspace, ARTIFACTS.outline)));
      if (parsed.success) outline = parsed.data;
    } catch { /* An unfinished outline is not yet a usable route/query plan. */ }
  }

  if (pending.has("literature")) {
    const closed = (state.scope.bibliography_mode ?? "seed") === "closed";
    if (closed && !suppliedBibliography(workspace)) {
      throw new UserFacingError("preflight: closed bibliography mode requires an author-supplied .bib file; no retrieval is permitted");
    }
    let needsRetrieval = !(closed && suppliedBibliography(workspace));
    let callsMade = 0;
    try {
      const cache = readJson<Record<string, unknown>>(join(workspace, ".po-run", "literature-cache.json"));
      const candidates = CandidatesSchema.safeParse(cache.candidates);
      if (Number.isInteger(cache.callsMade) && Number(cache.callsMade) >= 0 &&
          candidates.success && candidates.data.length > 0 &&
          Array.isArray(cache.completedQueries) && cache.completedQueries.every((q) => typeof q === "string")) {
        callsMade = Number(cache.callsMade);
      }
    } catch { /* Missing or malformed caches cannot waive retrieval readiness. */ }
    if (initialRetrievalSatisfied(workspace, state)) needsRetrieval = false;
    if (needsRetrieval) {
      if (state.scope.network_policy === "offline") {
        throw new UserFacingError("preflight: offline network policy forbids the literature retrieval required by this run");
      }
      if (!Number.isInteger(state.scope.max_lkm_calls) || state.scope.max_lkm_calls <= callsMade) {
        throw new UserFacingError("preflight: literature retrieval requires a positive remaining --max-lkm-calls budget");
      }
      if (!allowLkmSpend) {
        throw new UserFacingError("preflight: literature retrieval requires --allow-lkm-spend; no paid calls were made");
      }
      requireTool("bohr");
      try {
        // Identity readiness only, never `auth show`, a credential file, or a search.
        await execa("bohr", ["auth", "whoami"], {
          stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 15_000,
        });
      } catch {
        throw new UserFacingError("preflight: Bohrium authentication is not ready; sign in with `bohr auth login` and retry");
      }
    }
  }

  if (pending.has("plotting") && state.scope.use_plotting) {
    const routes = outline?.plotting_plan.map(resolveFigureRoute);
    const needsCode = routes ? routes.includes("code") : true;
    let needsImage = routes?.includes("text_to_image") ?? false;
    if (!routes && existsSync(join(workspace, BRIEF_FILE))) {
      const brief = readFileSync(join(workspace, BRIEF_FILE), "utf8");
      needsImage = brief.split(/[\n.!?]/).some((line) =>
        !/\b(no|not|without|avoid|supplied|existing)\b/i.test(line) &&
        /\b(generate|create|draw|include|require|must)\w*\b[^\n]{0,100}\b(diagram|schematic)\b/i.test(line));
    }
    if (needsCode) {
      const capability = await plottingAvailable();
      if (!capability.ok) throw new UserFacingError(`preflight: ${capability.detail}`);
      requireTool("pdftoppm");
    }
    if (needsImage) {
      if (state.scope.network_policy === "offline") {
        throw new UserFacingError("preflight: offline policy forbids required image generation");
      }
      const adapter = process.env[IMAGE_ADAPTER_ENV]?.trim();
      if (adapter && ((!isAbsolute(adapter) && adapter.includes("/")) || !executableAvailable(adapter))) {
        throw new UserFacingError(`preflight: ${IMAGE_ADAPTER_ENV} must name an executable on PATH or an absolute executable path`);
      }
      const capability = await textToImageCapability();
      if (!capability.ok) throw new UserFacingError(`preflight: ${capability.detail}`);
    }
  }
}
