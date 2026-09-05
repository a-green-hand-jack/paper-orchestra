import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkpoint, initGit } from "../checkpoints.js";
import { compactStamp } from "../timestamp.js";
import { opencodeVersion } from "../doctor.js";
import { ensureDir } from "../files.js";
import { UserFacingError } from "../errors.js";
import { importDirectory, importTemplateFiles, prepareBrainInput } from "../input.js";
import {
  discoverTemplate,
  templateLayout,
  type TemplateDiscovery,
} from "../template-discovery.js";
import { formatModelRef } from "../model.js";
import { BRIEF_FILE, paths } from "../paths.js";
import { STAGES, type StageId } from "../stages.js";
import { ScopeSchema, type ModelRef, type RunState, type Scope } from "../state/schema.js";
import {
  computeLockDigests,
  createRunState,
  writeRunState,
  type CreateRunInput,
} from "../state/store.js";

export interface PrepareOptions {
  readonly workspace: string;
  /**
   * The one input: a directory holding whatever the author has. The template,
   * the bibliography, the figures and the notes are all things that may or may
   * not be in there, and finding them is our job rather than the author's.
   */
  readonly rawMaterials: string;
  /**
   * An explicit template, overriding discovery. Null means "look in the input,
   * and fall back to a bundled venue if there is nothing there" -- which is
   * the path a Harbor container takes, since it hands an agent one location
   * and no way to name a second.
   */
  readonly templateDir: string | null;
  /**
   * The commissioning brief's text, or null. Written into `source/` before the
   * lock so it is an input like any other, rather than an argument only one
   * stage happens to see.
   */
  readonly brief?: string | null;
  /** Immutable adapter id or user-supplied directory label selected before preparation. */
  readonly templateId?: string;
  readonly templateSelection?: "automatic" | "explicit";
  readonly templateRationale?: string;
  readonly mode: "autonomous" | "collaborative";
  readonly headless: boolean;
  readonly usePlotting: boolean;
  readonly researchCutoff: string;
  readonly networkPolicy: "online" | "offline";
  readonly defaultModel: ModelRef | null;
  readonly stageModels: Record<string, ModelRef>;
  readonly timeoutMultiplier: number;
  /**
   * Truncate the locked plan after this stage. Lets the pipeline be adopted
   * one stage at a time, and keeps a partial run an explicit, locked decision
   * rather than an interrupted full run.
   */
  readonly until?: StageId | null;
  readonly maxLkmCalls: number;
  readonly targetCitations: number;
}

export interface PrepareResult {
  readonly state: RunState;
  readonly skipped: string[];
  /** Skip counts by reason, so a repo-sized import reports why, not just what. */
  readonly skippedByReason: Record<string, number>;
  readonly brainInputs: string[];
  readonly checkpointSha: string;
}

function newRunId(): string {
  return `${compactStamp()}-${randomBytes(3).toString("hex")}`;
}

/** Current UTC year-month, the default literature cutoff. */
/** The plan, optionally truncated after `until`. */
export function planFor(until: StageId | null): StageId[] {
  if (!until) return [...STAGES];
  const at = STAGES.indexOf(until);
  if (at < 0) throw new Error(`unknown stage "${until}"`);
  return STAGES.slice(0, at + 1) as StageId[];
}

export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Create an isolated workspace: import and lock materials and template, record
 * validated state, and take the first checkpoint.
 *
 * Refuses a non-empty workspace. Re-preparing over an existing run would
 * discard its checkpoints and locks, which is precisely the failure mode the
 * Python has today — `process_paper_task` unconditionally removes the per-paper
 * directory before starting, so an interrupted paper is wiped rather than
 * continued.
 */
/**
 * What to record as the run's venue.
 *
 * `scope.venue` has no functional consumer -- it is printed by `status` and
 * folded into `scope_digest` -- so its job is to tell a reader where the
 * template came from. A discovered one says so and gives the path, which is
 * the only way to tell from `run.json` alone that nobody named a template.
 */
function templateLabel(options: PrepareOptions, discovered: TemplateDiscovery | null): string {
  if (options.templateId) return options.templateId;
  if (discovered) return `discovered:${discovered.main}`;
  return basename(resolve(options.templateDir as string));
}

export async function prepareWorkspace(options: PrepareOptions): Promise<PrepareResult> {
  const workspace = resolve(options.workspace);
  const p = paths(workspace);

  if (existsSync(p.runState)) {
    throw new Error(
      `${workspace} already holds a run; use \`paper-orchestra resume ${workspace}\` instead ` +
        "of re-preparing, which would discard its checkpoints.",
    );
  }
  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    throw new Error(`workspace ${workspace} is not empty; choose a new directory`);
  }

  for (const dir of [
    p.brainInput,
    p.brainRaw,
    p.brainManuscript,
    p.brainTmp,
    p.runDir,
    p.checkpoints,
    p.logs,
  ]) {
    ensureDir(dir);
  }

  const raw = resolve(options.rawMaterials);

  // Discovery runs BEFORE the import, on the raw input, for two reasons. The
  // template has to be kept out of `source/` rather than removed from it
  // afterwards, and the import prunes noise directories -- so a kit sitting in
  // `build/` would be invisible to anything looking at `source/` and visible
  // to anything looking at the input, with no error either way.
  const discovered = options.templateDir === null ? discoverTemplate(raw) : null;
  const claimed = new Set(discovered?.templateFiles ?? []);

  // Either discovery found a template or the caller named one. The CLI
  // guarantees this -- `resolveTemplateSelection` runs precisely when discovery
  // comes back empty -- but saying so here turns a caller's mistake into a
  // sentence instead of `paths[0] must be of type string`, which is what an
  // input holding no LaTeX at all used to produce three frames deep.
  if (!discovered && options.templateDir === null) {
    throw new UserFacingError(
      `found no LaTeX template in ${raw} and none was supplied. Pass ` +
        "`--template <venue|dir>` to name one, or `--template auto` to have one chosen " +
        "from the paper's topic.",
    );
  }

  const source = importDirectory(raw, p.source, { exclude: claimed });
  const template = discovered
    ? importTemplateFiles(raw, p.template, templateLayout(discovered))
    : importDirectory(resolve(options.templateDir as string), p.template);

  // Before `computeLockDigests`, so the brief is inside the lock. After the
  // imports, so it cannot be shadowed by a file of the same name in the input
  // -- if the author already has a `source/BRIEF.md`, an explicit `--brief`
  // is the more specific instruction and wins.
  if (options.brief) {
    const briefPath = join(workspace, BRIEF_FILE);
    ensureDir(dirname(briefPath));
    rmSync(briefPath, { force: true });
    writeFileSync(briefPath, options.brief.endsWith("\n") ? options.brief : `${options.brief}\n`, "utf8");
    chmodSync(briefPath, 0o444);
  }

  const scope: Scope = ScopeSchema.parse({
    plan: planFor(options.until ?? null),
    use_plotting: options.usePlotting,
    research_cutoff: options.researchCutoff,
    venue: templateLabel(options, discovered),
    ...(options.templateId ? { template_id: options.templateId } : {}),
    ...(options.templateSelection || discovered
      ? { template_selection: options.templateSelection ?? "discovered" }
      : {}),
    ...(options.templateRationale || discovered
      ? {
          template_rationale:
            options.templateRationale ??
            `Found ${(discovered as TemplateDiscovery).main} in the supplied input.`,
        }
      : {}),
    network_policy: options.networkPolicy,
    max_lkm_calls: options.maxLkmCalls,
    target_citations: options.targetCitations,
  });

  const digests = computeLockDigests(workspace);
  const runId = newRunId();
  const runBranch = `po/run-${runId}`;

  const createInput: CreateRunInput = {
    runId,
    runBranch,
    mode: options.mode,
    headless: options.headless,
    scope,
    sourceDigest: digests.sourceDigest,
    templateDigest: digests.templateDigest,
    defaultModel: options.defaultModel,
    stageModels: options.stageModels,
    opencodeVersion: await opencodeVersion(),
    timeoutMultiplier: options.timeoutMultiplier,
  };

  let state = createRunState(createInput);
  state = writeRunState(workspace, state);

  const brain = await prepareBrainInput(workspace);

  state = writeRunState(workspace, { ...state, status: "prepared" });

  await initGit(workspace, runBranch);
  const checkpointSha = await checkpoint({
    workspace,
    runId,
    stage: "prepare",
    status: "prepared",
    mode: options.mode,
    model: formatModelRef(options.defaultModel),
  });

  const skippedByReason: Record<string, number> = {};
  for (const counts of [source.skippedByReason, template.skippedByReason]) {
    for (const [reason, count] of Object.entries(counts)) {
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
    }
  }

  return {
    state,
    skipped: [...source.skipped, ...template.skipped, ...brain.skipped],
    skippedByReason,
    brainInputs: brain.files,
    checkpointSha,
  };
}
