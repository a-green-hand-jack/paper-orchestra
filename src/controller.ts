import { checkpoint, initGit } from "./checkpoints.js";
import { UserFacingError } from "./errors.js";
import { formatModelRef, modelForStage } from "./model.js";
import {
  type AttachedTui,
  type Runtime,
  attachTui,
  createSession,
  lastAssistantText,
  prompt,
  sessionUsage,
  startRuntime,
  stopTui,
  usageDelta,
  waitForIdle,
} from "./opencode.js";
import { buildRemediationPrompt, buildStagePrompt, OPERATION_REQUEST_CONTRACT } from "./prompts.js";
import { beginBudgetRun, endBudgetRun, checkBudget, consumeBudget, readBudget, increaseTokenBudget } from "./budget.js";
import { executeOperations, type OperationHandlers } from "./operations.js";
import { permissionsFor } from "./permissions.js";
import { watchPermissionAsks } from "./opencode.js";
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
import { citationFloor, validateStage } from "./validation.js";
import { CitationMapSchema, OutlineSchema } from "./artifacts.js";
import { assertInside, digestFile, digestValue, readJson, writeJsonAtomic } from "./files.js";
import { retrieveForLiterature, UnmetLiteratureError } from "./literature-controller.js";
import { preflightRun } from "./preflight.js";
import { manuscriptReadiness, reviewManuscript, reviewRepairTargets } from "./manuscript-review.js";
import { analyzeSourceTables, exportSubmission, publishTables } from "./presentation.js";
import { compileLatex, stageBuildDir } from "./latexbuild.js";
import { renderPdfPages } from "./latexbuild.js";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { FigureInfoSchema } from "./artifacts.js";
import { ensureDir } from "./files.js";
import { paths } from "./paths.js";
import { ARTIFACTS } from "./paths.js";
import { join } from "node:path";
import { acquireRunLock } from "./state/lock.js";
import {
  parseVisualReview,
  plottingAvailable,
  renderFigure,
  resolveFigureRoute,
  type VisualReview,
} from "./figures.js";
import { generateTextImage, textToImageCapability } from "./imagegen.js";
import { materialsInventory, suppliedFiguresDir } from "./input.js";
import {
  bibliographyOriginNote,
  suppliedBibliography,
  toSuppliedCandidates,
} from "./bibliography.js";
import { ensureGraphicxPackage } from "./latex.js";

export interface ControllerOptions {
  readonly workspace: string;
  readonly headless: boolean;
  /**
   * Literature retrieval costs real money per call, so it is opt-in per
   * invocation rather than locked into the run: an operator who resumes a run
   * should have to authorize spending again.
   */
  readonly allowLkmSpend?: boolean;
  readonly maxTotalTokens?: number;
  readonly onEvent?: (line: string) => void;
  /** Shared by nested figure/writer sessions within one controller invocation. */
  readonly operationTurns?: Partial<Record<StageId, number>>;
  readonly operationActive?: Set<string>;
}

const GATE_POLL_MS = 500;

function say(options: ControllerOptions, line: string): void {
  (options.onEvent ?? ((text: string) => process.stdout.write(`${text}\n`)))(line);
}

function stageModel(state: RunState, stage: StageId): ModelRef | null {
  const overrides = state.stage_models as Record<string, ModelRef>;
  return modelForStage(stage, state.default_model, overrides);
}

function availableCitationKeys(workspace: string): string {
  try {
    const parsed = CitationMapSchema.safeParse(readJson(join(workspace, ARTIFACTS.citationMap)));
    return parsed.success ? Object.keys(parsed.data).sort().join(", ") : "";
  } catch {
    return "";
  }
}

/** A TUI may close while a completed stage is waiting at its approval gate. */
export function stageNeedsFailureMark(state: RunState, stage: StageId): boolean {
  return state.stages[stage].status !== "completed";
}

/**
 * Run the pipeline from the first unfinished stage to the end.
 *
 * Per stage: prompt, wait for idle, validate, one bounded remediation, resolve
 * the gate, checkpoint, advance. Completion is decided by the validators, never
 * by the model's closing message.
 */
export async function runController(options: ControllerOptions): Promise<RunState> {
  // Resolved once, here, and passed down, so every path the controller derives
  // is absolute.
  //
  // `prepareWorkspace` already resolves (`commands/prepare.ts`), so `run.json`
  // records an absolute workspace while the controller used to receive the raw
  // CLI string. With the default `-o ./po-run-<timestamp>` that string is
  // relative, and the two disagreed. Mostly invisible -- until a subprocess is
  // given a workspace-derived path together with a `cwd` inside the workspace,
  // at which point the relative path resolves against the wrong base and every
  // code-route figure fails to open its own script.
  const resolved: ControllerOptions = { ...options, workspace: resolve(options.workspace),
    operationTurns: {}, operationActive: new Set() };
  // Taken before any state is read or written: a second controller on this
  // workspace would interleave checkpoints and race state writes.
  const runLock = acquireRunLock(resolved.workspace);
  try {
    if (resolved.maxTotalTokens !== undefined) increaseTokenBudget(resolved.workspace, resolved.maxTotalTokens);
    beginBudgetRun(resolved.workspace);
    return await drive(resolved, runLock);
  } finally {
    try { endBudgetRun(resolved.workspace); } finally { runLock.release(); }
  }
}

async function drive(
  options: ControllerOptions,
  _lock: { release(): void },
): Promise<RunState> {
  const { workspace } = options;
  let state = readRunState(workspace);
  verifyLocks(workspace, state);
  analyzeSourceTables(workspace);
  await preflightRun(workspace, state, options.allowLkmSpend ?? false);

  await initGit(workspace, state.run_branch);
  const installed = installRuntimeAssets(workspace, state);
  say(options, `installed ${installed.length} runtime asset(s)`);

  const runtime = await startRuntime(workspace, { permission: permissionsFor(state.mode) });
  say(options, `opencode server ${runtime.serverUrl}`);

  const sessions: Record<string, string> = {};
  const abort = new AbortController();
  let tui: AttachedTui | null = null;
  let activeStage: Promise<RunState> | null = null;
  if (!options.headless) {
    tui = attachTui(runtime, workspace);
  }
  const onSignal = (): void => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    state = updateRunState(workspace, (current) => ({
      ...current,
      status: "running",
      error: null,
    }));

    for (;;) {
      const stage = resumeStage(readRunState(workspace));
      if (!stage) break;
      checkBudget(workspace);
      writeJsonAtomic(join(workspace, ".brain/requests.json"), []);
      activeStage = runStage(runtime, options, stage, sessions, abort.signal);
      if (tui) {
        state = await Promise.race([
          activeStage,
          tui.exited.then((code) => {
            abort.abort();
            throw new UserFacingError(
              code === 127
                ? "could not start the native OpenCode TUI; is `opencode` on PATH?"
                : `native OpenCode TUI exited with code ${code}; run state was preserved`,
            );
          }),
        ]);
      } else {
        state = await activeStage;
      }
      activeStage = null;
      if (state.status === "gate_waiting") return state;
    }

    if (state.scope.plan.includes("refinement")) {
      const ready = manuscriptReadiness(workspace);
      if (!ready.passed) throw new UserFacingError(ready.detail);
      exportSubmission(workspace);
    }
    state = updateRunState(workspace, (current) => ({
      ...current,
      status: "completed",
      current_stage: null,
      completed_at: new Date().toISOString(),
      error: null,
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

    if (stage && stageNeedsFailureMark(current, stage)) {
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
    if (activeStage) await activeStage.catch(() => undefined);
    writeSessionState(workspace, { serverUrl: runtime.serverUrl, sessions });
    if (tui) await stopTui(tui);
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
  // Claim the stage before any provider, capability, or session setup. If one
  let priorError = state.stages[stage].error;
  if (priorError) {
    const currentFailures = validateStage(workspace, stage, state.scope).filter((check) => !check.passed);
    if (currentFailures.length) priorError = currentFailures.map((check) => `${check.name}: ${check.detail}`).join("; ");
  }
  // of those fails, the persisted failure belongs to this stage rather than
  // overwriting the previously completed stage named by current_stage.
  updateRunState(workspace, (current) => ({
    ...current,
    current_stage: stage,
    status: "running",
  }));
  const model = stageModel(state, stage);
  const timeoutMs = Math.round(TIMEOUTS_MS[stage] * state.timeout_multiplier);

  say(options, "");

  // Plotting with generation ON runs a per-figure loop rather than the single
  // prompt every other stage uses, so it has its own path.
  if (stage === "plotting" && state.scope.use_plotting) {
    return runPlottingGeneration(runtime, options, sessions, signal, state);
  }

  // Plotting with generation disabled needs no model at all: the figures are
  // supplied, so the controller just publishes them and lets the validators
  // confirm. Prompting a session here would spend tokens to do nothing.
  if (stage === "plotting" && !state.scope.use_plotting) {
    publishTables(workspace);
    say(options, `>> ${TITLES[stage]} (${stage})  supplied figures, no model call`);
    const published = publishSuppliedFigures(workspace);
    say(options, `   published ${published} supplied figure(s)`);

    const checks = validateStage(workspace, stage, state.scope);
    const blockers = blocking(checks);
    reportChecks(options, checks);
    if (blockers.length > 0) {
      updateStage(workspace, stage, (s) => ({
        ...s,
        status: "failed",
        attempts: s.attempts + 1,
        error: blockers.map((c) => `${c.name}: ${c.detail}`).join("; "),
      }));
      throw new UserFacingError(
        `stage "${stage}" failed validation: ` +
          blockers.map((check) => `${check.name}: ${check.detail}`).join("; "),
      );
    }

    const completed = updateStage(workspace, stage, (s) => ({
      ...s,
      status: "completed",
      attempts: s.attempts + 1,
      started_at: s.started_at ?? new Date().toISOString(),
      completed_at: new Date().toISOString(),
      notes: `Published ${published} supplied figure(s); plotting disabled.`,
    }));
    const sha = await checkpoint({
      workspace,
      runId: completed.run_id,
      stage,
      status: "completed",
      mode: completed.mode,
      checks,
    });
    say(options, `   ok  ${checks.length} checks  ckpt=${sha.slice(0, 12)}`);
    return resolveGate(options, stage, completed, signal);
  }

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
    stage,
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

  const extra: Record<string, string> = {};
  if (stage === "triage") {
    // Hand the model a map instead of a turn spent globbing, and give
    // `materials_considered` something a validator can compare against.
    extra.materials = materialsInventory(workspace);
  }
  if (stage === "literature") {
    const relevant = await retrieveForLiterature(options, state);
    // The floor is a target capped by availability, NOT a fraction of the
    // retrieval volume. The Python cited 90% of whatever came back
    // (literature_review_agent.py:492), which is only defensible when every
    // hit is on-topic; against a general-science corpus it forced the
    // off-domain tail into the manuscript. `citation_floor` enforces the same
    // number at the END of the pipeline, so refinement cannot quietly undo it.
    extra.paper_count = String(relevant);
    // The outline is on disk and schema-checked by the time this runs, so the
    // floor the model is told matches the one the validators will enforce.
    const plan = OutlineSchema.safeParse(readJson(join(workspace, ARTIFACTS.outline)));
    extra.min_cite_paper_count = String(
      citationFloor(relevant, state.scope, plan.success ? plan.data : null),
    );
    extra.bibliography_origin = bibliographyOriginNote(workspace, state.scope.bibliography_mode ?? "seed");
  }
  if (stage === "section_writing" || stage === "refinement") {
    extra.citation_keys = availableCitationKeys(workspace);
  }

  const before = await sessionUsage(runtime, sessionId);

  if (stage === "refinement") {
    const reviewingFinal = existsSync(join(workspace, ARTIFACTS.finalTex));
    await buildIfManuscriptStage(options, reviewingFinal ? "refinement" : "section_writing");
    await reviewManuscript({ runtime, workspace, sourceRel: reviewingFinal ? ARTIFACTS.finalTex : ARTIFACTS.rawDraft,
      model, timeoutMs, signal, onProgress: (line) => say(options, line) });
    await repairReviewedFigures(runtime, options, sessions, signal, reviewingFinal ? ARTIFACTS.finalTex : ARTIFACTS.rawDraft);
  }

  await prompt(runtime, {
    sessionId,
    text: buildStagePrompt(workspace, stage, state.scope, extra) +
      "\nRead .brain/writer-continuation.json if present; handle open canonical targets, including table presentation sidecars. Resolved review findings need no repair." + (priorError
      ? `\n\nRESUMING AN EXISTING ATTEMPT. Inspect its existing output first and repair the following failure. ` +
        `Preserve correct work instead of rewriting the whole stage.\n${priorError}` : ""),
    model,
  });
  const first = await waitForIdleOrPermissionAsk(runtime, options, {
    sessionId,
    timeoutMs,
    signal,
  });
  if (!first.startedWork) {
    throw new UserFacingError(
      `stage "${stage}" never started: the session accepted the prompt but did no work. ` +
        "Check the model reference and provider authentication.",
    );
  }

  if (stage === "literature") {
    // The literature writer can identify missing sources, but only the controller searches.
    for (let round = 0; round < 2; round += 1) {
      const revised = OutlineSchema.safeParse(readJson(join(workspace, ARTIFACTS.outlineV1)));
      if (!revised.success || revised.data.citation_gaps.length === 0) break;
      let retrievalFeedback = "The controller retrieved your citation_gaps.";
      try {
        await retrieveForLiterature(options, state, revised.data.citation_gaps);
      } catch (error) {
        if (!(error instanceof UnmetLiteratureError)) throw error;
        retrievalFeedback = `The controller could not resolve these searches: ${error.gaps.join("; ")}. ` +
          "Within the remaining call budget, rephrase actual external citation needs. Alternatively " +
          "narrow/remove an unsupported external claim and record the concrete revised claim, location " +
          "and reason in citation_gap_resolutions. Do not demand an independently published identical " +
          "result for original research, new experiments, or universal correctness proof. Preserve all " +
          "brief requirements, research outcomes and minimum relevant citation count. Budget exhaustion " +
          "does not itself resolve a gap.";
      }
      await prompt(runtime, { sessionId, model, text:
        retrievalFeedback + " Re-read .brain/raw/candidates.json and .brain/raw/citation_map.json; " +
        "update outline_v1.json and updated_template.tex using these sources. Clear only resolved " +
        "citation_gaps, documenting cited or claim_narrowed resolutions, or state concrete remaining searches. " +
        "Do not change controller-owned bibliography files." });
      await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal });
    }
  }

  await buildIfManuscriptStage(options, stage);
  if (stage === "refinement" && readJson<{ok: boolean}>(join(workspace, ARTIFACTS.buildReport))?.ok) {
    await reviewManuscript({ runtime, workspace, sourceRel: ARTIFACTS.finalTex,
      model, timeoutMs, signal, onProgress: (line) => say(options, line) });
    await repairReviewedFigures(runtime, options, sessions, signal, ARTIFACTS.finalTex);
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
      text: buildRemediationPrompt(stage, failed) + "\nRead .brain/writer-continuation.json for structured repair assignments. Only independent review can resolve findings.",
      model,
    });
    await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal });
    await buildIfManuscriptStage(options, stage);
    if (stage === "refinement" && readJson<{ok: boolean}>(join(workspace, ARTIFACTS.buildReport))?.ok) {
      await reviewManuscript({ runtime, workspace, sourceRel: ARTIFACTS.finalTex,
        model, timeoutMs, signal, onProgress: (line) => say(options, line) });
      await repairReviewedFigures(runtime, options, sessions, signal, ARTIFACTS.finalTex);
    }

    checks = validateStage(workspace, stage, state.scope);
    failed = checks.filter((check) => !check.passed);
    reportChecks(options, checks);
  }

  const usage = usageDelta(before, await sessionUsage(runtime, sessionId));
  const notes = (await lastAssistantText(runtime, sessionId)).split("\n")[0]?.slice(0, 200) ?? "";

  const blockers = blocking(checks);
  if (blockers.length > 0) {
    updateStage(workspace, stage, (s) => ({ ...s, usage, notes }));
    throw new UserFacingError(
      `stage "${stage}" failed validation after ${budget} remediation attempt(s): ` +
        blockers.map((check) => `${check.name}: ${check.detail}`).join("; "),
    );
  }
  const remaining = checks.filter((check) => !check.passed);
  if (remaining.length > 0) {
    say(
      options,
      `   ${remaining.length} advisory finding(s) remain: ` +
        remaining.map((check) => check.name).join(", "),
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

  return resolveGate(options, stage, state, signal);
}

function reportChecks(options: ControllerOptions, checks: readonly Check[]): void {
  for (const check of checks) {
    if (check.passed) continue;
    say(options, `   ${check.advisory ? "WARN" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

/**
 * The failures that end a stage.
 *
 * Every failed check is handed to remediation, but only a blocking one decides
 * that the stage did not happen. Otherwise a finished, compiling, fully cited
 * manuscript is thrown away over a table that is 19pt too wide -- which is what
 * used to happen, twice in a five-task sample.
 */
function blocking(checks: readonly Check[]): Check[] {
  return checks.filter((check) => !check.passed && !check.advisory);
}

/**
 * Hold a collaborative run at a milestone until it is approved.
 *
 * The gate lives in `run.json`, not in memory, so `paper-orchestra approve` can
 * release it from any process. A headless run has nobody to ask, so it stops
 * cleanly with state persisted rather than blocking forever.
 */
export async function resolveGate(
  options: ControllerOptions,
  stage: StageId,
  state: RunState,
  signal?: AbortSignal,
): Promise<RunState> {
  if (state.mode !== "collaborative" || !COLLABORATIVE_GATES.includes(stage)) return state;

  if (options.headless) {
    const waiting = updateRunState(options.workspace, (c) => ({
      ...c,
      status: "gate_waiting",
    }));
    say(
      options,
      `stage "${stage}" is complete and awaiting approval. State is saved. ` +
        `Approve with \`paper-orchestra approve ${options.workspace}\`, then continue with ` +
        `\`paper-orchestra resume ${options.workspace}\`.`,
    );
    return waiting;
  }

  updateRunState(options.workspace, (c) => ({ ...c, status: "gate_waiting" }));
  endBudgetRun(options.workspace);
  say(
    options,
    `   gate: waiting for approval - run \`paper-orchestra approve ${options.workspace}\``,
  );

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
    signal?.throwIfAborted();
    const current = readRunState(options.workspace);
    if (current.status !== "gate_waiting") {
      beginBudgetRun(options.workspace);
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

/** Which stages produce a manuscript the controller should compile. */
const MANUSCRIPT_SOURCE: Partial<Record<StageId, string>> = {
  section_writing: ARTIFACTS.rawDraft,
  refinement: ARTIFACTS.finalTex,
};

/**
 * Compile the manuscript and record the result for `latex_assembly`.
 *
 * The agent has no `bash`, so it cannot run pdflatex and cannot claim a
 * successful build. The controller compiles in a scratch directory, writes a
 * build report the validator reads, and publishes the PDF alongside the
 * manuscript. Compilation happens before validation on every attempt,
 * including after a remediation round, so a check never reports on a stale PDF.
 */
async function buildIfManuscriptStage(
  options: ControllerOptions,
  stage: StageId,
): Promise<void> {
  const sourceRel = MANUSCRIPT_SOURCE[stage];
  if (!sourceRel) return;

  const { workspace } = options;
  const sourceAbs = join(workspace, sourceRel);
  if (!existsSync(sourceAbs)) return; // artifact_exists reports this better.
  try {
    publishTables(workspace);
  } catch (error) {
    writeJsonAtomic(join(workspace, ARTIFACTS.buildReport), { ok: false, source: sourceRel,
      pdf: null, pages: null, errors: [`Invalid table_presentation.json or table plan: ${String(error)}`],
      built_at: new Date().toISOString() });
    return;
  }

  const source = readFileSync(sourceAbs, "utf8");
  const withGraphicx = ensureGraphicxPackage(source);
  if (withGraphicx !== source) writeFileSync(sourceAbs, withGraphicx, "utf8");

  const buildDir = stageBuildDir(workspace, sourceAbs, "manuscript");
  const result = await compileLatex({ cwd: buildDir, jobName: "manuscript" });

  writeJsonAtomic(join(workspace, ARTIFACTS.buildReport), {
    ok: result.ok,
    source: sourceRel,
    pdf: result.pdf ? ARTIFACTS.finalPdf : null,
    pages: result.pages,
    errors: result.errors,
    unresolved_citation_marks: result.unresolvedCitationMarks,
    overfull_boxes: result.overfullBoxes,
    built_at: new Date().toISOString(),
  });

  if (result.pdf) {
    copyFileSync(result.pdf, join(workspace, ARTIFACTS.finalPdf));
    say(
      options,
      `   compiled ${sourceRel} -> ${result.pages ?? "?"} page(s)` +
        (result.unresolvedCitationMarks > 0
          ? `, ${result.unresolvedCitationMarks} unresolved citation mark(s)`
          : "") +
        (result.overfullBoxes[0] && result.overfullBoxes[0].points >= 10
          ? `, ${Math.round(result.overfullBoxes[0].points)}pt column overflow`
          : ""),
    );
  } else {
    say(options, `   compile FAILED (${result.errors.length} error(s))`);
  }
}

/**
 * Publish user-supplied figures into the manuscript tree.
 *
 * The Python requires the user to hand-write `figures/info.json` in the
 * non-plotting path (`paper_writer.py:145` reads it and the CLI only warns when
 * figures are absent), so a missing caption file surfaces as a confusing
 * downstream failure. Here the controller synthesizes it from whatever is in
 * `source/figures/`, falling back to the filename as the caption so the section
 * writer always has something to place.
 */
/**
 * Plotting with generation enabled.
 *
 * Structured as a per-figure loop rather than one prompt, because each figure
 * has its own success criterion -- a process produced pixels -- and its own
 * repair. One prompt asking for five scripts would make one bad script poison
 * four good ones, and would give the remediation nothing specific to fix.
 *
 * The division of labour is the same one the rest of the pipeline uses: the
 * model writes the script and the caption, the CONTROLLER executes, collects,
 * and writes both artifacts. `plotting_results.json` and `figures/info.json`
 * therefore record what actually rendered, not what a model claimed rendered.
 */
async function visuallyReviewFigure(
  runtime: Runtime,
  options: ControllerOptions,
  input: {
    sessionId: string;
    model: ModelRef | null;
    imagePath: string;
    reviewDir: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<VisualReview> {
  let preview = input.imagePath;
  if (extname(preview).toLowerCase() === ".pdf") {
    const pages = await renderPdfPages(preview, input.reviewDir, 1);
    if (!pages[0]) {
      return { passed: false, suggestions: "the PDF could not be rasterized for visual review" };
    }
    preview = pages[0];
  }

  const extension = extname(preview).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  const data = readFileSync(preview).toString("base64");
  await prompt(runtime, {
    sessionId: input.sessionId,
    model: input.model,
    text: [
      "Act as a strict publication-figure visual critic. Inspect the attached rendered image,",
      "not the generating code or a textual description. Fail it if content overlaps internally,",
      "labels or ticks are unreadable at the intended full figure size, content is clipped, axes/units are wrong or",
      "misleading, or the layout contains any other visible defect.",
      "Do not assume every figure will be reduced to a narrow two-column thumbnail. Wide figures can use the full text width; the final manuscript review checks their actual printed size.",
      "Return exactly one JSON object: {\"passed\": boolean, \"suggestions\": string}.",
      "When passed is false, suggestions must be a concrete repair instruction.",
    ].join("\n"),
    files: [{ mime, url: `data:${mime};base64,${data}`, filename: basename(preview) }],
  });
  await waitForIdleOrPermissionAsk(runtime, options, {
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    model: input.model,
  });
  return parseVisualReview(await lastAssistantText(runtime, input.sessionId));
}

async function runPlottingGeneration(
  runtime: Runtime,
  options: ControllerOptions,
  sessions: Record<string, string>,
  signal: AbortSignal,
  initial: RunState,
  targetIds?: readonly string[],
  repairInstructions?: string,
): Promise<RunState> {
  const stage: StageId = "plotting";
  const { workspace } = options;
  const p = paths(workspace);
  let state = initial;
  const model = stageModel(state, stage);
  const timeoutMs = Math.round(TIMEOUTS_MS[stage] * state.timeout_multiplier);

  publishTables(workspace);
  const parsed = OutlineSchema.safeParse(readJson(join(workspace, ARTIFACTS.outlineV1)));
  if (!parsed.success) {
    throw new UserFacingError(
      `cannot generate figures: ${ARTIFACTS.outline} does not match its schema. ` +
        "Re-run the outline stage.",
    );
  }

  const planned = parsed.data.plotting_plan.filter((spec) => !targetIds || targetIds.includes(spec.figure_id));
  if (targetIds && planned.length !== targetIds.length) throw new UserFacingError("Unknown canonical figure target");
  const routed = planned.map((spec) => ({ spec, route: resolveFigureRoute(spec) }));
  const codeCount = routed.filter((entry) => entry.route === "code").length;
  const imageCount = routed.length - codeCount;
  if (imageCount > 0 && state.scope.network_policy === "offline") {
    throw new UserFacingError("offline policy forbids text-to-image network calls");
  }

  if (codeCount > 0) {
    const capability = await plottingAvailable();
    if (!capability.ok) {
      throw new UserFacingError(`cannot use the code-generation figure route: ${capability.detail}`);
    }
  }
  if (imageCount > 0) {
    const capability = await textToImageCapability();
    if (!capability.ok) throw new UserFacingError(capability.detail);
  }

  say(
    options,
    `>> ${TITLES[stage]} (${stage})  model=${formatModelRef(model)}  ` +
      `${codeCount} code route, ${imageCount} text-to-image route`,
  );

  const sessionId = await createSession(runtime, { title: `paper-orchestra ${stage}`, stage });
  sessions[stage] = sessionId;
  writeSessionState(workspace, { serverUrl: runtime.serverUrl, sessions });

  if (!targetIds) state = updateStage(workspace, stage, (s) => ({
    ...s,
    status: "running",
    attempts: s.attempts + 1,
    remediations: 0,
    started_at: new Date().toISOString(),
    error: null,
    session_id: sessionId,
    model,
  }));
  if (!targetIds) updateRunState(workspace, (c) => ({ ...c, current_stage: stage, status: "running" }));

  const before = await sessionUsage(runtime, sessionId);
  const figuresDir = join(p.brainManuscript, "figures");
  ensureDir(figuresDir);

  // Supplied figures still publish: generation ADDS to what the author gave,
  // it does not replace it. A run may legitimately supply a hand-drawn
  // architecture diagram and generate its result plots.
  const supplied = targetIds ? 0 : publishSuppliedFigures(workspace);
  const info = FigureInfoSchema.parse(readJson(join(workspace, ARTIFACTS.figuresInfo)) ?? []);
  const previous = existsSync(join(workspace, ARTIFACTS.plottingResults))
    ? readJson<Array<Record<string, unknown>>>(join(workspace, ARTIFACTS.plottingResults)) : [];
  const results: Array<Record<string, unknown>> = targetIds
    ? previous.filter((record) => !targetIds.includes(String(record.figure_id))) : [];
  if (targetIds) {
    const names = new Set(previous.filter((record) => targetIds.includes(String(record.figure_id)))
      .map((record) => basename(String(record.image_path ?? ""))));
    for (let index = info.length - 1; index >= 0; index--) if (names.has(info[index]!.name)) info.splice(index, 1);
  }
  // Older controller-written manuscript feedback lacked the per-figure round field.
  for (const record of previous) {
    if (targetIds && !targetIds.includes(String(record.figure_id))) continue;
    if (Array.isArray(record.critic_history)) record.critic_history.forEach((review, index) => {
      if (review.origin === "manuscript_review" && review.round === undefined) review.round = index;
    });
  }

  for (const { spec, route } of routed) {
    const cached = !targetIds && previous.find((result) => result.figure_id === spec.figure_id &&
      result.plan_sha256 === digestValue(spec) && typeof result.image_path === "string");
    if (cached) {
      const image = assertInside(p.brainManuscript, String(cached.image_path));
      if (existsSync(image) && cached.image_sha256 === digestFile(image)) {
        info.push({ name: basename(image), caption: String(cached.caption) });
        results.push(cached);
        say(options, `   ${spec.figure_id}: reused reviewed figure`);
        continue;
      }
    }
    const dataFiles = spec.data_source.map((source, index) => {
      const root = source.startsWith("source/") ? "source" :
        source.startsWith(".brain/input/") ? ".brain/input" : null;
      const relativeSource = root ? source.slice(root.length + 1) : "";
      if (!root || relativeSource.includes("\\") ||
          relativeSource.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new UserFacingError(`figure data must name an imported source: ${source}`);
      }
      return { path: assertInside(join(workspace, root), relativeSource), name: `${index}-${basename(source)}` };
    });
    const budget = REMEDIATION_ATTEMPTS[stage] + 1;
    let imagePath: string | null = null;
    let bytes = 0;
    let failure = "";
    let caption = "";
    let provenance: Record<string, unknown> | null = null;
    let metadata: unknown;
    const priorFigure = previous.find((result) => result.figure_id === spec.figure_id &&
      (result.plan_sha256 === digestValue(spec) ||
        (result.description === spec.objective && result.aspect_ratio === spec.aspect_ratio)));
    const criticHistory: Array<Record<string, unknown>> = Array.isArray(priorFigure?.critic_history)
      ? [...priorFigure.critic_history as Array<Record<string, unknown>>] : [];
    if (repairInstructions) criticHistory.push({ round: criticHistory.length, passed: false,
      suggestions: repairInstructions, origin: "operation_request" });

    for (let attempt = 0; attempt < budget; attempt += 1) {
      checkBudget(workspace);
      if (attempt > 0) {
        say(options, `   ${spec.figure_id}: retrying (${failure})`.slice(0, 180));
        if (!targetIds) state = updateStage(workspace, stage, (s) => ({
          ...s,
          remediations: s.remediations + 1,
        }));
      }

      if (route === "code") {
        const generationPrompt =
          attempt === 0
            ? buildStagePrompt(workspace, stage, state.scope, {
                figure_id: spec.figure_id,
                title: spec.title,
                objective: spec.objective,
                aspect_ratio: spec.aspect_ratio,
                data_source: spec.data_source.join(", ") || "(no data file named; the figure is conceptual)",
                data_files: dataFiles.map((file, index) => `${spec.data_source[index]} -> data/${file.name}`).join("\n"),
              }) + (criticHistory.length ? "\nPrior visual review feedback to address:\n" +
                criticHistory.filter((review) => review.passed === false)
                  .map((review) => String(review.suggestions ?? "")).join("\n") : "")
            : `The code-generated figure \`${spec.figure_id}\` failed: ${failure}\n\n` +
              "Return a complete corrected script in one ```python block and the caption as before.";
        await prompt(runtime, { sessionId, text: generationPrompt, model });
        await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal, model });
        const answer = await lastAssistantText(runtime, sessionId);
        const rendered = await renderFigure({
          figureId: spec.figure_id,
          code: answer,
          workDir: join(p.brainTmp, "figures", spec.figure_id, `attempt-${attempt}`),
          dataFiles,
          spec,
        });
        metadata = rendered.metadata;
        caption = extractCaption(answer) || spec.title || spec.objective;
        provenance = {
          provider: "opencode",
          model: formatModelRef(model),
          prompt: generationPrompt,
          parameters: { format: "pdf", network: "disabled", attempt },
        };
        imagePath = rendered.ok ? rendered.imagePath : null;
        bytes = rendered.bytes;
        failure = rendered.error ?? "";
      } else {
        const basePrompt =
          spec.generation_prompt.trim().replace(/^Provider\/model:[^.]*\.\s*/i, "") ||
          `${spec.title}. ${spec.objective}. Create a clear publication figure with aspect ratio ` +
            `${spec.aspect_ratio}; do not add unsupported quantitative claims.`;
        const repairs = [
          ...criticHistory.slice(-3).map((review) => String(review.suggestions ?? "")),
          failure.startsWith("visual review failed:") ? failure.replace(/^visual review failed:\s*/i, "") : "",
        ]
          .map((repair) => repair.trim())
          .filter((repair, index, all) => repair.length > 0 && all.indexOf(repair) === index);
        let generationPrompt =
          repairs.length === 0
            ? basePrompt
            : `${basePrompt}\n\nRepair every issue found by visual review:\n` +
              repairs.map((repair) => `- ${repair}`).join("\n");
        if (repairs.length >= 2) {
          generationPrompt += "\nRepeated spatial-layout repairs have failed. Redesign this as a simple " +
            "non-spatial conceptual definition map with clearly labelled boxes and relationships. " +
            "Do not draw perspective planes, physical trajectories or misleading vector projections. " +
            "Preserve the scientific definitions and required concepts; connectors indicate definition " +
            "dependencies, not physical vector directions. Clearly identify this as a conceptual relationship map.";
          generationPrompt += " Use at most five large boxes with concise labels/defining equations, not " +
            "explanatory paragraphs. Keep all lettering large (about 5% of image height), use uncrossed " +
            "connectors, and leave detailed explanations to the paper caption. Do not draw provenance " +
            "or executor metadata inside the image. In this simplified fallback use symbol names and " +
            "short descriptive labels only, not equations: formal definitions belong in the accompanying " +
            "caption and Methods. Never invent a mathematical relationship to fill a box.";
        }
        consumeBudget(workspace, "image");
        try {
          const generated = await generateTextImage({
            figureId: spec.figure_id,
            prompt: generationPrompt,
            aspectRatio: spec.aspect_ratio,
            workDir: join(p.brainTmp, "figures", spec.figure_id, `attempt-${attempt}`),
          });
          imagePath = generated.imagePath;
          bytes = generated.bytes;
          provenance = generated.provenance;
          caption = spec.title || spec.objective;
          failure = "";
        } catch (error) {
          imagePath = null;
          failure = error instanceof Error ? error.message : String(error);
        }
      }

      if (!imagePath || failure) continue;
      if (metadata) {
        await prompt(runtime, { sessionId, model, text: "Write only Caption: followed by an evidence-grounded caption for " +
          spec.figure_id + ". Use the actual rendered axes, scales, signed ranges, labels and source hashes below; " +
          "do not infer an absolute-value log plot from symlog.\n" + JSON.stringify(metadata) });
        await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal, model });
        caption = extractCaption(await lastAssistantText(runtime, sessionId)) || caption;
      }
      const review = await visuallyReviewFigure(runtime, options, {
        sessionId,
        model,
        imagePath,
        reviewDir: join(p.brainTmp, "figure-reviews", spec.figure_id, `attempt-${attempt}`),
        timeoutMs,
        signal,
      });
      criticHistory.push({
        round: attempt,
        passed: review.passed,
        suggestions: review.suggestions,
        revised_description: attempt === 0 ? "" : failure,
      });
      if (review.passed) break;
      failure = `visual review failed: ${review.suggestions}`;
      imagePath = null;
    }

    if (imagePath) {
      const target = join(figuresDir, `${spec.figure_id}${extname(imagePath).toLowerCase()}`);
      if (info.some((entry) => entry.name === basename(target))) {
        throw new UserFacingError(`duplicate published figure: ${basename(target)}`);
      }
      copyFileSync(imagePath, target);
      info.push({ name: basename(target), caption });
      say(options, `   ${spec.figure_id}: rendered ${basename(target)} (${bytes} bytes, ${route})`);
      results.push({
        figure_id: spec.figure_id,
        title: spec.title,
        task_name: spec.plot_type,
        render_route: route,
        description: spec.objective,
        caption,
        aspect_ratio: spec.aspect_ratio,
        critic_history: criticHistory,
        quantities: spec.quantities ?? [],
        data_sources: dataFiles.map((file, index) => ({ path: spec.data_source[index], sha256: digestFile(file.path) })),
        ...(metadata ? { runtime_metadata: metadata } : {}),
        ...(provenance ? { generation_provenance: provenance } : {}),
        image_path: join("figures", basename(target)),
        plan_sha256: digestValue(spec),
        image_sha256: digestFile(target),
      });
    } else {
      say(options, `   ${spec.figure_id}: FAILED - ${failure || "unknown"}`);
      results.push({
        figure_id: spec.figure_id,
        title: spec.title,
        task_name: spec.plot_type,
        render_route: route,
        description: spec.objective,
        caption,
        aspect_ratio: spec.aspect_ratio,
        critic_history: criticHistory,
        ...(provenance ? { generation_provenance: provenance } : {}),
        plan_sha256: digestValue(spec),
      });
    }
    writeJsonAtomic(join(workspace, ARTIFACTS.plottingResults), results);
    writeJsonAtomic(join(workspace, ARTIFACTS.figuresInfo), info);
  }

  writeJsonAtomic(join(workspace, ARTIFACTS.plottingResults), results);
  writeJsonAtomic(join(workspace, ARTIFACTS.figuresInfo), info);

  if (targetIds) {
    const missing = targetIds.filter((id) => !results.some((record) => record.figure_id === id && record.image_path));
    if (missing.length) throw new UserFacingError(`Targeted figure repair failed: ${missing.join(", ")}`);
    return readRunState(workspace);
  }

  const usage = usageDelta(before, await sessionUsage(runtime, sessionId));
  const checks = validateStage(workspace, stage, state.scope);
  const blockers = blocking(checks);
  reportChecks(options, checks);

  if (blockers.length > 0) {
    updateStage(workspace, stage, (s) => ({ ...s, status: "failed", usage }));
    throw new UserFacingError(
      `stage "${stage}" failed validation: ` +
        blockers.map((check) => `${check.name}: ${check.detail}`).join("; "),
    );
  }

  const rendered = results.filter((r) => r.image_path).length;
  const completed = updateStage(workspace, stage, (s) => ({
    ...s,
    status: "completed",
    completed_at: new Date().toISOString(),
    usage,
    notes: `Generated ${rendered}/${planned.length} figure(s); published ${supplied} supplied figure(s).`,
  }));
  const sha = await checkpoint({
    workspace,
    runId: completed.run_id,
    stage,
    status: "completed",
    mode: completed.mode,
    checks,
  });
  say(options, `   ok  ${checks.length} checks  ckpt=${sha.slice(0, 12)}`);
  return resolveGate(options, stage, completed, signal);
}

/**
 * The caption from a plotting answer.
 *
 * The model returns a script in a fenced block plus a caption; taking the
 * prose OUTSIDE the fence avoids matching a `# comment` that happens to
 * mention a caption. Falls back to the figure title upstream, so a model that
 * forgets the caption still yields a placed figure rather than a failed stage.
 */
async function repairReviewedFigures(runtime: Runtime, options: ControllerOptions,
  sessions: Record<string, string>, signal: AbortSignal, sourceRel: string): Promise<void> {
  const { workspace } = options;
  const targets = reviewRepairTargets(workspace);
  const regenerated: string[] = [];
  if (targets.figures.length && readRunState(workspace).scope.use_plotting) {
    const review = readJson<{ findings: Array<{target_id: string; status: string; problem: string; action: string}> }>(join(workspace, ".brain/manuscript/review.json"));
    const records = readJson<Array<Record<string, unknown>>>(join(workspace, ARTIFACTS.plottingResults));
    for (const record of records) {
      if (!targets.figures.includes(String(record.figure_id))) continue;
      const history = Array.isArray(record.critic_history) ? record.critic_history : [];
      record.critic_history = [...history, { round: history.length, passed: false, origin: "manuscript_review",
        suggestions: review.findings.filter((f) => f.status !== "resolved" && f.target_id === record.figure_id)
          .map((f) => `${f.problem} ${f.action}`).join("\n") }];
    }
    writeJsonAtomic(join(workspace, ARTIFACTS.plottingResults), records);
    await runPlottingGeneration(runtime, options, sessions, signal, readRunState(workspace), targets.figures);
    regenerated.push(...targets.figures);
  }
  // A structured continuation is a repair assignment, never an approval. Only
  // reviewManuscript may close findings in the independent issue ledger.
  writeJsonAtomic(join(workspace, ".brain/writer-continuation.json"), {
    source: sourceRel, status: "open", writer: targets.writer,
    tables: targets.tables.map((target_id) => ({ target_id, operation: "revise",
      instructions: "Edit only this table's entry in .brain/manuscript/table_presentation.json; controller regenerates before build." })),
    figures: targets.figures.map((target_id) => ({ target_id, status: regenerated.includes(target_id) ? "awaiting_independent_review" : "blocked",
      instructions: "Inspect current figure and runtime metadata; align caption with actual axes/labels. This is not approval." })),
  });
}

export function extractCaption(answer: string): string {
  const outsideFences = answer.replace(/```[\s\S]*?```/g, "\n");
  // `**` around the label is optional and may sit on either side of the colon:
  // models write `**Caption:**`, `**Caption**:` and `Caption:` about equally.
  const labelled = /^\s*(?:##+\s*)?\*{0,2}caption\*{0,2}\s*:?\s*\*{0,2}\s*$/im.exec(
    outsideFences,
  );
  if (labelled) {
    const after = outsideFences.slice(labelled.index + labelled[0].length);
    const line = after.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return stripCaptionLabel(line);
  }
  const inline = /^\s*(?:##+\s*)?\*{0,2}caption\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/im.exec(
    outsideFences,
  );
  if (inline?.[1]) return stripCaptionLabel(inline[1].trim());
  return "";
}

function stripCaptionLabel(line: string): string {
  return line
    .replace(/^\*\*caption:?\*\*\s*/i, "")
    .replace(/^caption:?\s*/i, "")
    // The LaTeX template numbers figures itself; a baked-in "Figure 3:" would
    // render as "Figure 1: Figure 3: ...".
    .replace(/^figure\s*\d*\s*:?\s*/i, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();
}

function publishSuppliedFigures(workspace: string): number {
  const p = paths(workspace);
  const suppliedRel = suppliedFiguresDir(workspace);
  const target = join(p.brainManuscript, "figures");
  ensureDir(target);

  if (suppliedRel === null) {
    writeJsonAtomic(join(workspace, ARTIFACTS.figuresInfo), []);
    return 0;
  }
  const sourceFigures = join(workspace, suppliedRel);

  const supplied = readdirSync(sourceFigures).filter((name) =>
    [".pdf", ".png", ".jpg", ".jpeg"].includes(extname(name).toLowerCase()),
  );
  for (const name of supplied) {
    const destination = join(target, name);
    // Imported source material is deliberately read-only. Remove the prior
    // published copy first so resuming plotting remains idempotent.
    rmSync(destination, { force: true });
    copyFileSync(join(sourceFigures, name), destination);
  }

  // Prefer captions the user supplied; fall back to the stem of the filename.
  const suppliedInfo = join(sourceFigures, "info.json");
  let captions: Record<string, string> = {};
  if (existsSync(suppliedInfo)) {
    const parsed = FigureInfoSchema.safeParse(readJson(suppliedInfo));
    if (parsed.success) {
      captions = Object.fromEntries(parsed.data.map((entry) => [entry.name, entry.caption]));
    }
  }

  writeJsonAtomic(
    join(workspace, ARTIFACTS.figuresInfo),
    supplied.map((name) => ({
      name,
      caption: captions[name] ?? basename(name, extname(name)).replace(/[_-]+/g, " "),
    })),
  );
  return supplied.length;
}

/** Exposed for tests: the supplied-figures publication step in isolation. */
export function runSuppliedFiguresForTest(workspace: string): number {
  return publishSuppliedFigures(workspace);
}

/**
 * Wait for the session to finish, but abandon the wait if it asks permission.
 *
 * A headless run cannot answer, so the session stays busy and the only signal
 * is the stage budget expiring -- with an error blaming the timeout rather than
 * the prompt. On a real run this cost thirty minutes to discover that
 * `external_directory` was set to `ask`, fifty seconds after the model had
 * already written every artifact correctly.
 */
async function waitForIdleOrPermissionAsk(
  runtime: Runtime,
  options: ControllerOptions,
  wait: { sessionId: string; timeoutMs: number; signal?: AbortSignal; model?: ModelRef | null; skipOperations?: boolean },
): Promise<{ startedWork: boolean }> {
  const watcher = watchPermissionAsks(runtime);
  try {
    const outcome = await Promise.race([
      waitForIdle(runtime, wait).then((result) => ({ kind: "idle" as const, result })),
      watcher.first.then((ask) => ({ kind: "permission" as const, ask })),
    ]);

    if (outcome.kind === "permission") {
      const { ask } = outcome;
      const detail = ask.resources.length > 0 ? ` for ${ask.resources.join(", ")}` : "";
      throw new UserFacingError(
        `the session asked permission to "${ask.action}"${detail}, which this run cannot ` +
          `grant. Permissions are set by the controller; if this action is legitimate, ` +
          `allow it in src/permissions.ts rather than answering interactively.`,
      );
    }
    if (!wait.skipOperations) await continueOperations(runtime, options, wait);
    return outcome.result;
  } finally {
    watcher.stop();
  }
}

async function continueOperations(runtime: Runtime, options: ControllerOptions,
  wait: { sessionId: string; timeoutMs: number; signal?: AbortSignal; model?: ModelRef | null }): Promise<void> {
  const { workspace } = options;
  const state = readRunState(workspace);
  const stage = state.current_stage;
  if (!stage) return;
  const turns = options.operationTurns ?? {};
  const active = options.operationActive ?? new Set<string>();
  const signal = wait.signal ?? new AbortController().signal;
  const model = wait.model === undefined ? stageModel(state, stage) : wait.model;
  const manuscriptStage = (): StageId => {
    if (!["section_writing", "refinement"].includes(stage)) throw new UserFacingError("Manuscript operations require writing/refinement stage");
    const selected = stage === "refinement" && existsSync(join(workspace, ARTIFACTS.finalTex)) ? "refinement" : "section_writing";
    if (!existsSync(join(workspace, MANUSCRIPT_SOURCE[selected]!))) throw new UserFacingError("Write the manuscript source before requesting build/review/revision");
    return selected;
  };
  const handlers: OperationHandlers = {
    retrieve: async ({ request }) => {
      if (!state.scope.plan.includes("literature") || !state.stages.outline.completed_at ||
          state.scope.network_policy === "offline" || !options.allowLkmSpend || !request.parameters.query)
        throw new UserFacingError("Retrieval requires a completed outline, literature scope, network/spend authorization and query");
      const count = await retrieveForLiterature(options, readRunState(workspace), [request.parameters.query]);
      return { outputs: [ARTIFACTS.candidates, ARTIFACTS.citationMap, ARTIFACTS.references], detail: `${count} relevant sources; inspect actual retrieval outputs` };
    },
    render: async ({ request }) => {
      if (!state.scope.use_plotting || !state.stages.literature.completed_at || !request.target_id || active.has("render"))
        throw new UserFacingError("Rendering requires completed literature, plotting enabled, canonical target and no recursive rendering");
      active.add("render");
      try {
        await runPlottingGeneration(runtime, options, {}, signal, readRunState(workspace), [request.target_id], request.parameters.instructions);
      } finally { active.delete("render"); }
      return { outputs: [ARTIFACTS.plottingResults, ARTIFACTS.figuresInfo], detail: `Rendered ${request.target_id}; independent manuscript review still required` };
    },
    revise: async ({ request }) => {
      const selected = manuscriptStage();
      const outline = OutlineSchema.parse(readJson(join(workspace, ARTIFACTS.outlineV1)));
      const table = outline.table_plan.find((entry) => entry.table_id === request.target_id);
      const section = outline.section_plan.find((entry) => entry.section_id === request.target_id);
      if (!table && !section) throw new UserFacingError("Revise requires a canonical table or section ID");
      if (table) {
        const sidecar = join(workspace, ".brain/manuscript/table_presentation.json");
        if (!existsSync(sidecar) || !Object.hasOwn(readJson<Record<string, unknown>>(sidecar), table.table_id))
          throw new UserFacingError(`Edit ${table.table_id}'s entry in .brain/manuscript/table_presentation.json before requesting revise; supported fields: caption, columns, row_labels, row_header. Numeric evidence is immutable.`);
        publishTables(workspace);
        return { outputs: [`.brain/manuscript/tables/${table.table_id}.tex`, `.brain/manuscript/tables/${table.table_id}.json`],
          detail: "Regenerated verified table from current model-editable table_presentation.json. If presentation is still wrong, edit that target's sidecar entry and request again with a new ID; not review approval." };
      }
      const source = MANUSCRIPT_SOURCE[selected]!;
      const continuation = { request_id: request.id, target_id: request.target_id, source, status: "open",
        instructions: request.parameters.instructions ?? "Repair this section according to open structured review findings",
        restrictions: "Same-session writer continuation: edit only the target section in this source; preserve other sections, evidence, bibliography, figure/table assets and canonical IDs. Do not mark findings resolved; rebuild and independently review." };
      const output = `.brain/raw/operations/${stage}/${request.id}.json`;
      writeJsonAtomic(join(workspace, output), continuation);
      return { outputs: [output], detail: "Writer continuation assigned, NOT a completed source edit. Read the structured assignment and perform the restricted edit in this session before claiming repair." };
    },
    build: async () => {
      const selected = manuscriptStage();
      await buildIfManuscriptStage(options, selected);
      const report = readJson<{ ok: boolean; errors: string[] }>(join(workspace, ARTIFACTS.buildReport));
      if (!report.ok) throw new UserFacingError("Build failed; inspect .brain/raw/build.json");
      return { outputs: [ARTIFACTS.buildReport, ARTIFACTS.finalPdf], detail: "Compiled actual manuscript; this is not review approval" };
    },
    review: async () => {
      const selected = manuscriptStage();
      await buildIfManuscriptStage(options, selected);
      const review = await reviewManuscript({ runtime, workspace, sourceRel: MANUSCRIPT_SOURCE[selected]!, model,
        timeoutMs: wait.timeoutMs, signal, onProgress: (line) => say(options, line) });
      return { outputs: [".brain/manuscript/review.json"], detail: `Independent review complete; ready=${review.ready}. Open findings remain binding.` };
    },
  };
  for (;;) {
    checkBudget(workspace);
    const ledger = readBudget(workspace);
    const remaining = ledger?.limits.max_operation_calls === undefined ? 64 :
      Math.max(0, ledger.limits.max_operation_calls - ledger.totals.operation_calls);
    const result = await executeOperations({ workspace, stage, handlers,
      maxExecutions: (turns[stage] ?? 0) >= 8 ? 0 : Math.min(64, remaining),
      beforeDispatch: () => {
        consumeBudget(workspace, "operation");
        writeJsonAtomic(join(workspace, ".brain/requests.json"), []);
      },
      onEvent: (line) => say(options, line) });
    if (!result.executed && !result.pending && !result.errors.length) return;
    if ((turns[stage] ?? 0) >= 8) throw new UserFacingError(`Stage ${stage} exceeded 8 operation continuation turns; unresolved requests preserved`);
    turns[stage] = (turns[stage] ?? 0) + 1;
    // The queue belongs to the next model turn. Historical failures remain in
    // operation-results, but omitted requests must not dispatch forever.
    writeJsonAtomic(join(workspace, ".brain/requests.json"), []);
    await prompt(runtime, { sessionId: wait.sessionId, model, text:
      OPERATION_REQUEST_CONTRACT + "\n\nRead .brain/operation-results.json now. " +
      `Executed=${result.executed}, pending=${result.pending}; operation admissions remaining=${Math.max(0, remaining - result.executed)}. ` +
      "Read every returned output/assignment. Failed or unavailable operations did not succeed: repair requests or choose an evidence-grounded alternative, without dropping requirements. " +
      "Native data requests do not restart this phase. Continue the interrupted task (including returning its plotting script if applicable), preserve stable IDs and correct artifacts. " +
      "Supported parameters: read offset/length (bytes); extract none; analyze aggregation=count|min|max|mean|sum, optional group_by, value_column required except count; retrieve query; render/revise/review instructions; build none. " +
      "retrieve requires completed outline and authorized online literature; render requires completed literature and plotting enabled; revise/build/review require manuscript writing. " +
      "For table revision edit target entry in table_presentation.json first, then request revise. Section revise returns an explicit writer continuation, not a fake edit. " +
      "When done leave requests.json empty; do not reissue completed requests merely to acknowledge them." });
    await waitForIdleOrPermissionAsk(runtime, options, { ...wait, skipOperations: true });
  }
}
