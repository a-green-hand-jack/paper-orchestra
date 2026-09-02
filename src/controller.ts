import { existsSync } from "node:fs";
import { checkpoint, initGit } from "./checkpoints.js";
import { UserFacingError } from "./errors.js";
import { formatModelRef, modelForStage } from "./model.js";
import {
  createSession,
  lastAssistantText,
  prompt,
  sessionUsage,
  startRuntime,
  usageDelta,
  waitForIdle,
  type Runtime,
} from "./opencode.js";
import { buildRemediationPrompt, buildStagePrompt } from "./prompts.js";
import { installRuntimeAssets } from "./assets.js";
import { COLLABORATIVE_GATES, REMEDIATION_ATTEMPTS, TIMEOUTS_MS, TITLES, type StageId } from "./stages.js";
import type { Check, ModelRef, RunState } from "./state/schema.js";
import {
  readRunState,
  resumeStage,
  updateRunState,
  updateStage,
  verifyLocks,
  writeSessionState,
} from "./state/store.js";
import { validateStage } from "./validation.js";
import { acquireRunLock } from "./state/lock.js";

export interface ControllerOptions {
  readonly workspace: string;
  readonly headless: boolean;
  readonly onEvent?: (line: string) => void;
}

const GATE_POLL_MS = 500;

function say(options: ControllerOptions, line: string): void {
  (options.onEvent ?? ((text: string) => process.stdout.write(`${text}\n`)))(line);
}

function stageModel(state: RunState, stage: StageId): ModelRef | null {
  const overrides = state.stage_models as Record<string, ModelRef>;
  return modelForStage(stage, state.default_model, overrides);
}

/**
 * Run the pipeline from the first unfinished stage to the end.
 *
 * Per stage: prompt, wait for idle, validate, one bounded remediation, resolve
 * the gate, checkpoint, advance. Completion is decided by the validators, never
 * by the model's closing message.
 */
export async function runController(options: ControllerOptions): Promise<RunState> {
  const { workspace } = options;
  // Taken before any state is read or written: a second controller on this
  // workspace would interleave checkpoints and race state writes.
  const runLock = acquireRunLock(workspace);
  try {
    return await drive(options, runLock);
  } finally {
    runLock.release();
  }
}

async function drive(
  options: ControllerOptions,
  _lock: { release(): void },
): Promise<RunState> {
  const { workspace } = options;
  let state = readRunState(workspace);
  verifyLocks(workspace, state);

  await initGit(workspace, state.run_branch);
  const installed = installRuntimeAssets(workspace, state);
  say(options, `installed ${installed.length} runtime asset(s)`);

  const runtime = await startRuntime(workspace);
  say(options, `opencode server ${runtime.serverUrl}`);

  const sessions: Record<string, string> = {};
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    state = updateRunState(workspace, (current) => ({ ...current, status: "running" }));

    for (;;) {
      const stage = resumeStage(readRunState(workspace));
      if (!stage) break;
      state = await runStage(runtime, options, stage, sessions, abort.signal);
    }

    state = updateRunState(workspace, (current) => ({
      ...current,
      status: "completed",
      current_stage: null,
      completed_at: new Date().toISOString(),
    }));
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: "run",
      status: "completed",
      mode: state.mode,
    });
    say(options, `run ${state.run_id} completed`);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = abort.signal.aborted;
    const current = readRunState(workspace);
    const stage = current.current_stage;

    if (stage) {
      updateStage(workspace, stage, (s) => ({
        ...s,
        status: interrupted ? "interrupted" : "failed",
        error: message,
      }));
    }
    state = updateRunState(workspace, (c) => ({
      ...c,
      status: interrupted ? "interrupted" : "failed",
      error: message,
    }));
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: stage ?? "run",
      status: interrupted ? "interrupted" : "failed",
      mode: state.mode,
    });
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    writeSessionState(workspace, { serverUrl: runtime.serverUrl, sessions });
    runtime.close();
  }
}

async function runStage(
  runtime: Runtime,
  options: ControllerOptions,
  stage: StageId,
  sessions: Record<string, string>,
  signal: AbortSignal,
): Promise<RunState> {
  const { workspace } = options;
  let state = readRunState(workspace);
  const model = stageModel(state, stage);
  const timeoutMs = Math.round(TIMEOUTS_MS[stage] * state.timeout_multiplier);

  say(options, "");
  say(
    options,
    `>> ${TITLES[stage]} (${stage})  model=${formatModelRef(model)}  ` +
      `budget=${Math.round(timeoutMs / 60000)}m`,
  );

  // A fresh session per stage. paper-run's evaluation traced a 6.7x token
  // blowup to one session carrying twelve stages; the artifacts on disk are the
  // cross-stage memory, so a new session loses nothing that matters.
  const sessionId = await createSession(runtime, {
    title: `paper-orchestra ${stage}`,
  });
  sessions[stage] = sessionId;
  writeSessionState(workspace, { serverUrl: runtime.serverUrl, sessions });

  state = updateStage(workspace, stage, (s) => ({
    ...s,
    status: "running",
    attempts: s.attempts + 1,
    remediations: 0,
    started_at: new Date().toISOString(),
    error: null,
    session_id: sessionId,
    model,
  }));
  updateRunState(workspace, (c) => ({ ...c, current_stage: stage, status: "running" }));

  const before = await sessionUsage(runtime, sessionId);

  await prompt(runtime, {
    sessionId,
    text: buildStagePrompt(workspace, stage, state.scope),
    model,
  });
  const first = await waitForIdle(runtime, { sessionId, timeoutMs, signal });
  if (!first.startedWork) {
    throw new UserFacingError(
      `stage "${stage}" never started: the session accepted the prompt but did no work. ` +
        "Check the model reference and provider authentication.",
    );
  }

  let checks = validateStage(workspace, stage, state.scope);
  let failed = checks.filter((check) => !check.passed);
  reportChecks(options, checks);

  const budget = REMEDIATION_ATTEMPTS[stage];
  for (let round = 0; failed.length > 0 && round < budget; round += 1) {
    say(options, `   remediating ${failed.length} finding(s) (round ${round + 1}/${budget})`);
    state = updateStage(workspace, stage, (s) => ({ ...s, remediations: s.remediations + 1 }));

    await prompt(runtime, {
      sessionId,
      text: buildRemediationPrompt(stage, failed),
      model,
    });
    await waitForIdle(runtime, { sessionId, timeoutMs, signal });

    checks = validateStage(workspace, stage, state.scope);
    failed = checks.filter((check) => !check.passed);
    reportChecks(options, checks);
  }

  const usage = usageDelta(before, await sessionUsage(runtime, sessionId));
  const notes = (await lastAssistantText(runtime, sessionId)).split("\n")[0]?.slice(0, 200) ?? "";

  if (failed.length > 0) {
    updateStage(workspace, stage, (s) => ({ ...s, usage, notes }));
    throw new UserFacingError(
      `stage "${stage}" failed validation after ${budget} remediation attempt(s): ` +
        failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    );
  }

  state = updateStage(workspace, stage, (s) => ({
    ...s,
    status: "completed",
    completed_at: new Date().toISOString(),
    usage,
    notes,
  }));

  const sha = await checkpoint({
    workspace,
    runId: state.run_id,
    stage,
    status: "completed",
    mode: state.mode,
    sessionId,
    model: formatModelRef(model),
    checks,
  });
  say(
    options,
    `   ok  ${checks.length} checks  in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `msgs=${usage.transcript_messages}  ckpt=${sha.slice(0, 12)}`,
  );

  return resolveGate(options, stage, state);
}

function reportChecks(options: ControllerOptions, checks: readonly Check[]): void {
  for (const check of checks) {
    if (!check.passed) say(options, `   FAIL ${check.name}: ${check.detail}`);
  }
}

/**
 * Hold a collaborative run at a milestone until it is approved.
 *
 * The gate lives in `run.json`, not in memory, so `paper-orchestra approve` can
 * release it from any process. A headless run has nobody to ask, so it stops
 * cleanly with state persisted rather than blocking forever.
 */
async function resolveGate(
  options: ControllerOptions,
  stage: StageId,
  state: RunState,
): Promise<RunState> {
  if (state.mode !== "collaborative" || !COLLABORATIVE_GATES.includes(stage)) return state;

  if (options.headless) {
    updateRunState(options.workspace, (c) => ({ ...c, status: "gate_waiting" }));
    updateStage(options.workspace, stage, (s) => ({ ...s, status: "completed" }));
    throw new UserFacingError(
      `stage "${stage}" is complete and awaiting approval, but this run is headless ` +
        `and cannot ask. State is saved. Approve with:\n` +
        `  paper-orchestra approve ${options.workspace}\n` +
        `then continue with:\n  paper-orchestra resume ${options.workspace}`,
    );
  }

  updateRunState(options.workspace, (c) => ({ ...c, status: "gate_waiting" }));
  say(
    options,
    `   gate: waiting for approval - run \`paper-orchestra approve ${options.workspace}\``,
  );

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
    const current = readRunState(options.workspace);
    if (current.status !== "gate_waiting") {
      say(options, "   gate: approved");
      return current;
    }
  }
}

/** Release a waiting gate. Separate process, hence the file-based handshake. */
export function approveRun(workspace: string): RunState {
  if (!existsSync(workspace)) {
    throw new UserFacingError(`no such workspace: ${workspace}`);
  }
  const state = readRunState(workspace);
  if (state.status !== "gate_waiting") {
    throw new UserFacingError(
      `run ${state.run_id} is "${state.status}", not waiting at a gate; nothing to approve`,
    );
  }
  return updateRunState(workspace, (c) => ({ ...c, status: "running" }));
}
