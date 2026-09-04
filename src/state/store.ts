import { existsSync } from "node:fs";
import { digestTree, digestValue, readJson, walkFiles, writeJsonAtomic } from "../files.js";
import { UserFacingError } from "../errors.js";
import { paths } from "../paths.js";
import { STAGES, type StageId } from "../stages.js";
import { PAPER_ORCHESTRA_VERSION, RUN_SCHEMA_VERSION, SESSION_SCHEMA_VERSION } from "../version.js";
import {
  RunStateSchema,
  SessionStateSchema,
  StageStateSchema,
  type ModelRef,
  type RunState,
  type Scope,
  type SessionState,
  type StageState,
} from "./schema.js";

/**
 * Raised when state on disk is unusable or a lock has been violated.
 * User-facing: a refused resume is an expected outcome the operator must act
 * on, so it prints as a message rather than a stack trace.
 */
export class StateError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function freshStage(): StageState {
  return StageStateSchema.parse({});
}

export interface CreateRunInput {
  readonly runId: string;
  readonly runBranch: string;
  readonly mode: "autonomous" | "collaborative";
  readonly headless: boolean;
  readonly scope: Scope;
  readonly sourceDigest: string;
  readonly templateDigest: string;
  readonly defaultModel: ModelRef | null;
  readonly stageModels: Record<string, ModelRef>;
  readonly opencodeVersion: string;
  readonly timeoutMultiplier: number;
}

export function createRunState(input: CreateRunInput): RunState {
  const at = nowIso();
  return RunStateSchema.parse({
    schema_version: RUN_SCHEMA_VERSION,
    run_id: input.runId,
    run_branch: input.runBranch,
    status: "preparing",
    mode: input.mode,
    headless: input.headless,
    stages: Object.fromEntries(STAGES.map((id) => [id, freshStage()])),
    current_stage: null,
    scope: input.scope,
    scope_digest: digestValue(input.scope),
    source_digest: input.sourceDigest,
    template_digest: input.templateDigest,
    default_model: input.defaultModel,
    stage_models: input.stageModels,
    versions: {
      paper_orchestra: PAPER_ORCHESTRA_VERSION,
      opencode: input.opencodeVersion,
      node: process.version,
    },
    timeout_multiplier: input.timeoutMultiplier,
    created_at: at,
    updated_at: at,
    completed_at: null,
    error: null,
  });
}

export function readRunState(workspace: string): RunState {
  const file = paths(workspace).runState;
  if (!existsSync(file)) {
    throw new StateError(`no run state at ${file}; is this a paper-orchestra workspace?`);
  }
  const raw = readJson(file) as { schema_version?: unknown };

  // Check the version BEFORE the schema. A run.json from an older plan fails
  // parsing twice over -- the literal schema_version, and StagesSchema
  // requiring a key for every stage -- and surfaces as "is invalid", which
  // reads like a corrupt file rather than an older one.
  if (typeof raw.schema_version === "string" && raw.schema_version !== RUN_SCHEMA_VERSION) {
    throw new StateError(
      `run state at ${file} is ${raw.schema_version}, but this version reads ` +
        `${RUN_SCHEMA_VERSION}. The plan gained a "triage" stage, so an older run cannot be ` +
        "resumed in place: its outline was written without one, and inventing the missing " +
        "stage entry would make the run's own provenance record assert a stage that never " +
        "ran. The work is preserved on the run branch; start a new run for further writing.",
    );
  }

  const parsed = RunStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StateError(`run state at ${file} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function writeRunState(workspace: string, state: RunState): RunState {
  const next = RunStateSchema.parse({ ...state, updated_at: nowIso() });
  writeJsonAtomic(paths(workspace).runState, next);
  return next;
}

/** Read, apply `mutate`, validate, write. The only way state should change. */
export function updateRunState(
  workspace: string,
  mutate: (state: RunState) => RunState,
): RunState {
  return writeRunState(workspace, mutate(readRunState(workspace)));
}

export function updateStage(
  workspace: string,
  id: StageId,
  mutate: (stage: StageState) => StageState,
): RunState {
  return updateRunState(workspace, (state) => ({
    ...state,
    stages: { ...state.stages, [id]: StageStateSchema.parse(mutate(state.stages[id])) },
  }));
}

export function readSessionState(workspace: string): SessionState | null {
  const file = paths(workspace).sessionState;
  if (!existsSync(file)) return null;
  const parsed = SessionStateSchema.safeParse(readJson(file));
  return parsed.success ? parsed.data : null;
}

export function writeSessionState(
  workspace: string,
  input: { serverUrl: string; sessions: Record<string, string> },
): SessionState {
  const existing = readSessionState(workspace);
  const state = SessionStateSchema.parse({
    schema_version: SESSION_SCHEMA_VERSION,
    server_url: input.serverUrl,
    sessions: input.sessions,
    pid: process.pid,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
  });
  writeJsonAtomic(paths(workspace).sessionState, state);
  return state;
}

/** Relative file lists for the two protected trees. */
export function protectedFiles(workspace: string): { source: string[]; template: string[] } {
  const p = paths(workspace);
  return { source: walkFiles(p.source), template: walkFiles(p.template) };
}

export function computeLockDigests(workspace: string): {
  sourceDigest: string;
  templateDigest: string;
} {
  const p = paths(workspace);
  const files = protectedFiles(workspace);
  return {
    sourceDigest: digestTree(p.source, files.source),
    templateDigest: digestTree(p.template, files.template),
  };
}

/**
 * Re-verify everything locked at `prepared`.
 *
 * A resume that silently accepted changed inputs would produce a manuscript
 * whose provenance no longer matches its checkpoints, so a mismatch refuses the
 * run rather than warning. The scope digest is recomputed from the recorded
 * scope, which catches hand-editing of `run.json` itself.
 */
export function verifyLocks(workspace: string, state: RunState): void {
  const problems: string[] = [];

  if (digestValue(state.scope) !== state.scope_digest) {
    problems.push("scope digest mismatch: run.json scope was edited after the run was prepared");
  }

  const { sourceDigest, templateDigest } = computeLockDigests(workspace);
  if (sourceDigest !== state.source_digest) {
    problems.push("source/ changed since import");
  }
  if (templateDigest !== state.template_digest) {
    problems.push("template/ changed since import");
  }

  if (problems.length > 0) {
    throw new StateError(
      `refusing to resume ${state.run_id}: ${problems.join("; ")}. ` +
        "Start a new run rather than continuing against changed inputs.",
    );
  }
}

/**
 * The stage a run should execute next: the first in plan order that is not
 * completed. Deriving this from the plan rather than storing a pointer means a
 * partially-written state file cannot send the controller to the wrong stage.
 */
export function resumeStage(state: RunState): StageId | null {
  for (const id of state.scope.plan) {
    if (state.stages[id].status !== "completed") return id;
  }
  return null;
}

/** Stages already finished, for `status` output. */
export function completedStages(state: RunState): StageId[] {
  return state.scope.plan.filter((id) => state.stages[id].status === "completed");
}
