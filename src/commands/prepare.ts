import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { checkpoint, initGit } from "../checkpoints.js";
import { compactStamp } from "../timestamp.js";
import { opencodeVersion } from "../doctor.js";
import { ensureDir } from "../files.js";
import { importDirectory, prepareBrainInput } from "../input.js";
import { formatModelRef } from "../model.js";
import { paths } from "../paths.js";
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
  readonly rawMaterials: string;
  readonly templateDir: string;
  readonly mode: "autonomous" | "collaborative";
  readonly headless: boolean;
  readonly usePlotting: boolean;
  readonly researchCutoff: string;
  readonly ideaFilename: string;
  readonly experimentalLogFilename: string;
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
}

export interface PrepareResult {
  readonly state: RunState;
  readonly skipped: string[];
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

  const source = importDirectory(resolve(options.rawMaterials), p.source);
  const template = importDirectory(resolve(options.templateDir), p.template);

  const scope: Scope = ScopeSchema.parse({
    plan: planFor(options.until ?? null),
    use_plotting: options.usePlotting,
    research_cutoff: options.researchCutoff,
    idea_filename: options.ideaFilename,
    experimental_log_filename: options.experimentalLogFilename,
    venue: basename(resolve(options.templateDir)),
    network_policy: options.networkPolicy,
    max_lkm_calls: options.maxLkmCalls,
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

  const brainInputs = await prepareBrainInput(workspace);

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

  return {
    state,
    skipped: [...source.skipped, ...template.skipped],
    brainInputs,
    checkpointSha,
  };
}
