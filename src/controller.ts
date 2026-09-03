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
import { buildRemediationPrompt, buildStagePrompt } from "./prompts.js";
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
import { readJson, writeJsonAtomic } from "./files.js";
import { LKM_CALL_PRICE_CNY, retrieveLiterature, toBibtex, toCitationMap } from "./literature.js";
import { planQueries } from "./queries.js";
import { compileLatex, stageBuildDir } from "./latexbuild.js";
import { renderPdfPages } from "./latexbuild.js";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
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
    say(options, `>> ${TITLES[stage]} (${stage})  supplied figures, no model call`);
    const published = publishSuppliedFigures(workspace);
    say(options, `   published ${published} supplied figure(s)`);

    const checks = validateStage(workspace, stage, state.scope);
    const failed = checks.filter((check) => !check.passed);
    reportChecks(options, checks);
    if (failed.length > 0) {
      updateStage(workspace, stage, (s) => ({
        ...s,
        status: "failed",
        attempts: s.attempts + 1,
        error: failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
      }));
      throw new UserFacingError(
        `stage "${stage}" failed validation: ` +
          failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
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
  if (stage === "literature") {
    const relevant = await retrieveForLiterature(options, state);
    // The floor is a target capped by availability, NOT a fraction of the
    // retrieval volume. The Python cited 90% of whatever came back
    // (literature_review_agent.py:492), which is only defensible when every
    // hit is on-topic; against a general-science corpus it forced the
    // off-domain tail into the manuscript. `citation_floor` enforces the same
    // number at the END of the pipeline, so refinement cannot quietly undo it.
    extra.paper_count = String(relevant);
    extra.min_cite_paper_count = String(citationFloor(relevant, state.scope));
  }
  if (stage === "section_writing" || stage === "refinement") {
    extra.citation_keys = availableCitationKeys(workspace);
  }

  const before = await sessionUsage(runtime, sessionId);

  await prompt(runtime, {
    sessionId,
    text: buildStagePrompt(workspace, stage, state.scope, extra),
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

  await buildIfManuscriptStage(options, stage);

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
    await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal });
    await buildIfManuscriptStage(options, stage);

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

  return resolveGate(options, stage, state, signal);
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
  say(
    options,
    `   gate: waiting for approval - run \`paper-orchestra approve ${options.workspace}\``,
  );

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
    signal?.throwIfAborted();
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

/**
 * Retrieve the bibliography before the literature stage prompts anything.
 *
 * The agent cannot search: `webfetch` and `websearch` are denied, so it cannot
 * cite a source it was not handed, and every entry it can cite carries a
 * provider id. That is what makes `bibliography_provenance` meaningful, and it
 * is the structural answer to a manuscript inventing references.
 *
 * The Python instead let the model search via Gemini's GoogleSearch tool, which
 * requires model-side web access this project deliberately withholds.
 */
async function retrieveForLiterature(
  options: ControllerOptions,
  state: RunState,
): Promise<number> {
  const { workspace } = options;
  const outlinePath = join(workspace, ARTIFACTS.outline);
  const parsed = OutlineSchema.safeParse(readJson(outlinePath));
  if (!parsed.success) {
    throw new UserFacingError(
      `cannot retrieve literature: ${ARTIFACTS.outline} does not match its schema. ` +
        "Re-run the outline stage.",
    );
  }

  const planned = planQueries(parsed.data);
  const queries = planned.queries;
  writeJsonAtomic(join(workspace, ARTIFACTS.queryPlan), {
    generated_at: new Date().toISOString(),
    decisions: planned.decisions,
  });
  const dropped = planned.decisions.filter((entry) => entry.action === "dropped").length;
  const contextualized = planned.decisions.filter(
    (entry) => entry.action === "contextualized",
  ).length;
  say(
    options,
    `   query plan: ${queries.length} paid call candidate(s), ${dropped} dropped, ` +
      `${contextualized} contextualized`,
  );
  const budget = Math.min(queries.length, state.scope.max_lkm_calls);

  if (!options.allowLkmSpend) {
    throw new UserFacingError(
      `the literature stage needs ${budget} Bohrium LKM call(s), costing about ` +
        `${(budget * LKM_CALL_PRICE_CNY).toFixed(2)} CNY. Re-run with ` +
        "--allow-lkm-spend to authorize it.",
    );
  }

  say(options, `   retrieving literature: ${budget} of ${queries.length} query(ies)`);

  const result = await retrieveLiterature({
    queries,
    cutoff: state.scope.research_cutoff,
    maxCalls: budget,
    outline: parsed.data,
    onProgress: (line) => say(options, line),
  });

  writeJsonAtomic(join(workspace, ARTIFACTS.candidates), result.candidates);
  writeFileSync(join(workspace, ARTIFACTS.references), toBibtex(result.candidates), "utf8");
  writeJsonAtomic(join(workspace, ARTIFACTS.citationMap), toCitationMap(result.candidates));

  say(
    options,
    `   retained ${result.candidates.length} source(s) from ${result.callsMade} call(s) ` +
      `(~${(result.callsMade * LKM_CALL_PRICE_CNY).toFixed(2)} CNY); dropped ` +
      `${result.dropped.anachronistic} after cutoff, ${result.dropped.noAbstract} without ` +
      `abstract, ${result.dropped.duplicate} duplicate, ${result.dropped.irrelevant} off-topic`,
  );

  // Name the queries that returned nothing usable. Each one cost money, and
  // per-query yield is the only evidence that distinguishes a badly phrased
  // query from a genuinely thin corpus.
  const barren = result.perQuery.filter((entry) => entry.admitted === 0);
  if (barren.length > 0) {
    say(
      options,
      `   ${barren.length} query(ies) yielded no relevant source: ` +
        barren.map((entry) => `"${entry.query.slice(0, 40)}"`).join(", "),
    );
  }

  if (result.candidates.length === 0) {
    throw new UserFacingError(
      "literature retrieval produced no source relevant to this paper, so the manuscript " +
        "could only cite nothing. Check `bohr auth whoami`, widen the research cutoff, or " +
        "revisit the outline's citation hints -- relevance is scored against the outline.",
    );
  }
  return result.candidates.length;
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
      "labels or ticks are unreadable at column width, content is clipped, axes/units are wrong or",
      "misleading, or the layout contains any other visible defect.",
      "Return exactly one JSON object: {\"passed\": boolean, \"suggestions\": string}.",
      "When passed is false, suggestions must be a concrete repair instruction.",
    ].join("\n"),
    files: [{ mime, url: `data:${mime};base64,${data}`, filename: basename(preview) }],
  });
  await waitForIdleOrPermissionAsk(runtime, options, {
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  return parseVisualReview(await lastAssistantText(runtime, input.sessionId));
}

async function runPlottingGeneration(
  runtime: Runtime,
  options: ControllerOptions,
  sessions: Record<string, string>,
  signal: AbortSignal,
  initial: RunState,
): Promise<RunState> {
  const stage: StageId = "plotting";
  const { workspace } = options;
  const p = paths(workspace);
  let state = initial;
  const model = stageModel(state, stage);
  const timeoutMs = Math.round(TIMEOUTS_MS[stage] * state.timeout_multiplier);

  const parsed = OutlineSchema.safeParse(readJson(join(workspace, ARTIFACTS.outline)));
  if (!parsed.success) {
    throw new UserFacingError(
      `cannot generate figures: ${ARTIFACTS.outline} does not match its schema. ` +
        "Re-run the outline stage.",
    );
  }

  const planned = parsed.data.plotting_plan;
  const routed = planned.map((spec) => ({ spec, route: resolveFigureRoute(spec) }));
  const codeCount = routed.filter((entry) => entry.route === "code").length;
  const imageCount = routed.length - codeCount;

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

  const sessionId = await createSession(runtime, { title: `paper-orchestra ${stage}` });
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
  const figuresDir = join(p.brainManuscript, "figures");
  ensureDir(figuresDir);

  // Supplied figures still publish: generation ADDS to what the author gave,
  // it does not replace it. A run may legitimately supply a hand-drawn
  // architecture diagram and generate its result plots.
  const supplied = publishSuppliedFigures(workspace);
  const info = FigureInfoSchema.parse(readJson(join(workspace, ARTIFACTS.figuresInfo)) ?? []);
  const results: Array<Record<string, unknown>> = [];

  for (const { spec, route } of routed) {
    const budget = REMEDIATION_ATTEMPTS[stage] + 1;
    let imagePath: string | null = null;
    let bytes = 0;
    let failure = "";
    let caption = "";
    let provenance: Record<string, unknown> | null = null;
    const criticHistory: Array<Record<string, unknown>> = [];

    for (let attempt = 0; attempt < budget; attempt += 1) {
      if (attempt > 0) {
        say(options, `   ${spec.figure_id}: retrying (${failure})`.slice(0, 180));
        state = updateStage(workspace, stage, (s) => ({
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
                data_source: spec.data_source,
              })
            : `The code-generated figure \`${spec.figure_id}\` failed: ${failure}\n\n` +
              "Return a complete corrected script in one ```python block and the caption as before.";
        await prompt(runtime, { sessionId, text: generationPrompt, model });
        await waitForIdleOrPermissionAsk(runtime, options, { sessionId, timeoutMs, signal });
        const answer = await lastAssistantText(runtime, sessionId);
        const rendered = await renderFigure({
          figureId: spec.figure_id,
          code: answer,
          workDir: join(p.brainTmp, "figures", spec.figure_id, `attempt-${attempt}`),
        });
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
          spec.generation_prompt.trim() ||
          `${spec.title}. ${spec.objective}. Create a clear publication figure with aspect ratio ` +
            `${spec.aspect_ratio}; do not add unsupported quantitative claims.`;
        const repairs = [
          ...criticHistory.map((review) => String(review.suggestions ?? "")),
          failure.replace(/^visual review failed:\s*/i, ""),
        ]
          .map((repair) => repair.trim())
          .filter((repair, index, all) => repair.length > 0 && all.indexOf(repair) === index);
        const generationPrompt =
          attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nRepair every issue found by visual review:\n` +
              repairs.map((repair) => `- ${repair}`).join("\n");
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
      const target = join(figuresDir, basename(imagePath));
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
        ...(provenance ? { generation_provenance: provenance } : {}),
        image_path: join("figures", basename(target)),
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
      });
    }
  }

  writeJsonAtomic(join(workspace, ARTIFACTS.plottingResults), results);
  writeJsonAtomic(join(workspace, ARTIFACTS.figuresInfo), info);

  const usage = usageDelta(before, await sessionUsage(runtime, sessionId));
  const checks = validateStage(workspace, stage, state.scope);
  const failed = checks.filter((check) => !check.passed);
  reportChecks(options, checks);

  if (failed.length > 0) {
    updateStage(workspace, stage, (s) => ({ ...s, status: "failed", usage }));
    throw new UserFacingError(
      `stage "${stage}" failed validation: ` +
        failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
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
  const sourceFigures = join(p.source, "figures");
  const target = join(p.brainManuscript, "figures");
  ensureDir(target);

  if (!existsSync(sourceFigures)) {
    writeJsonAtomic(join(workspace, ARTIFACTS.figuresInfo), []);
    return 0;
  }

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
  wait: { sessionId: string; timeoutMs: number; signal?: AbortSignal },
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
    return outcome.result;
  } finally {
    watcher.stop();
  }
}
