import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { UserFacingError } from "./errors.js";
import { digestValue, readJson, writeJsonAtomic } from "./files.js";
import { paths } from "./paths.js";
import { BudgetLedgerSchema, BudgetLimitsSchema, BudgetTotalsSchema, UsageSchema,
  type BudgetLedger, type BudgetLimits, type Usage } from "./state/schema.js";
import { readRunState, verifyLocks } from "./state/store.js";

/** Limits constrain authorized work; none of these values authorize spending. */
export const DEFAULT_BUDGET_LIMITS = {
  max_total_tokens: 8_000_000,
  max_total_cost: 100,
  max_model_calls: 80,
  max_image_calls: 12,
  max_operation_calls: 64,
  max_run_minutes: 120,
} satisfies BudgetLimits;

type Totals = BudgetLedger["totals"];
type Event = BudgetLedger["events"][number];
// The controller's run lock owns writes. No wall-clock timestamp is carried
// across processes: a stopped run must not accrue days of paused time.
const active = new Map<string, { tick: number; stage: string }>();
const ledgerPath = (workspace: string): string => join(paths(workspace).runDir, "budget.json");

export class BudgetExceededError extends UserFacingError {
  constructor(message: string) {
    super(`Run budget exhausted: ${message}. Existing outputs are preserved; limits do not authorize spend.`);
    this.name = "BudgetExceededError";
  }
}

/** Read-only snapshot for status/result output, including every accounting event. */
export function readBudget(workspace: string): BudgetLedger | null {
  if (!existsSync(paths(workspace).runState)) return null;
  const state = readRunState(workspace);
  const limits = BudgetLimitsSchema.parse(state.scope);
  if (!existsSync(ledgerPath(workspace))) {
    if (Object.keys(limits).length > 0 && Object.values(state.stages).some((stage) => stage.attempts > 0)) {
      throw new UserFacingError("Run budget ledger is missing for a started bounded run; refusing to reset usage. Restore .po-run/budget.json from the run's durable state.");
    }
    return BudgetLedgerSchema.parse({
      version: 1, run_id: state.run_id, limits, totals: {}, stages: {}, sessions: {}, events: [],
      historical_usage_unknown: Object.values(state.stages).some((stage) => stage.attempts > 0),
      updated_at: new Date().toISOString(),
    });
  }
  try {
    const ledger = BudgetLedgerSchema.parse(readJson(ledgerPath(workspace)));
    const effectiveLimits = { ...limits };
    let previousUsage = 0;
    for (const increase of ledger.token_limit_increases ?? []) {
      if (increase.from !== effectiveLimits.max_total_tokens || increase.to <= increase.from ||
          increase.used_tokens < previousUsage || increase.used_tokens > ledger.totals.total_tokens) {
        throw new Error("invalid token-limit increase history");
      }
      effectiveLimits.max_total_tokens = increase.to;
      previousUsage = increase.used_tokens;
    }
    if (ledger.run_id !== state.run_id || digestValue(ledger.limits) !== digestValue(effectiveLimits)) {
      throw new Error("ledger run or limits differ from locked scope");
    }
    return ledger;
  } catch (error) {
    throw new UserFacingError(`Cannot read run budget; refusing unaccounted execution: ${String(error)}`);
  }
}

function event(ledger: BudgetLedger, stage: string, kind: string, delta: Partial<Totals>, extra: Partial<Event> = {}): void {
  const total = ledger.stages[stage] ??= BudgetTotalsSchema.parse({});
  for (const key of Object.keys(delta) as Array<keyof Totals>) {
    ledger.totals[key] += delta[key] ?? 0;
    total[key] += delta[key] ?? 0;
  }
  const at = new Date().toISOString();
  const last = ledger.events.at(-1);
  if (kind === "elapsed" && last?.kind === kind && last.stage === stage) {
    last.delta.active_ms = (last.delta.active_ms ?? 0) + (delta.active_ms ?? 0);
    last.at = at;
  } else ledger.events.push({ at, stage, kind, delta, ...extra });
}

function save(workspace: string, ledger: BudgetLedger): void {
  ledger.updated_at = new Date().toISOString();
  writeJsonAtomic(ledgerPath(workspace), BudgetLedgerSchema.parse(ledger));
  // An admitted call must survive a crash, not just an atomic reader-visible rename.
  for (const path of [ledgerPath(workspace), paths(workspace).runDir]) {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** Preparation persists even zero limits without admitting any work. */
export function initializeBudget(workspace: string): BudgetLedger | null {
  const ledger = readBudget(workspace);
  if (ledger) save(workspace, ledger);
  return ledger;
}

/** Explicit operator increase, under the run lock. One atomic ledger write keeps
 * the original scope and every consumption counter intact, including on crash. */
export function increaseTokenBudget(workspace: string, limit: number): BudgetLedger {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new UserFacingError("--max-total-tokens must be a positive safe integer");
  const state = readRunState(workspace);
  verifyLocks(workspace, state);
  const ledger = readBudget(workspace);
  const previous = ledger?.limits.max_total_tokens;
  if (!ledger || previous === undefined) throw new UserFacingError("This run has no finite token limit to increase");
  if (limit < previous) throw new UserFacingError(`Resume can only increase the token limit; current limit is ${previous}`);
  if (limit === previous) return ledger;
  ledger.token_limit_increases = [...(ledger.token_limit_increases ?? []), {
    at: new Date().toISOString(), from: previous, to: limit, used_tokens: ledger.totals.total_tokens,
  }];
  ledger.limits.max_total_tokens = limit;
  event(ledger, state.current_stage ?? "prepare", "token_limit_increase", {}, {
    detail: `Explicit resume authorization: ${previous} -> ${limit}; used tokens preserved: ${ledger.totals.total_tokens}`,
  });
  save(workspace, ledger);
  return ledger;
}

function tick(workspace: string, ledger: BudgetLedger): void {
  const clock = active.get(resolve(workspace));
  if (!clock) return;
  const now = performance.now();
  event(ledger, clock.stage, "elapsed", { active_ms: Math.max(0, now - clock.tick) });
  clock.tick = now;
  clock.stage = readRunState(workspace).current_stage ?? "prepare";
}

function exhausted(ledger: BudgetLedger): string | null {
  const pairs: Array<[keyof BudgetLimits, keyof Totals, number]> = [
    ["max_total_tokens", "total_tokens", 1], ["max_total_cost", "known_cost_usd", 1],
    ["max_model_calls", "prompt_admissions", 1], ["max_image_calls", "image_calls", 1],
    ["max_operation_calls", "operation_calls", 1], ["max_run_minutes", "active_ms", 60_000],
  ];
  for (const [limit, metric, scale] of pairs) {
    const cap = ledger.limits[limit];
    // Call caps are enforced at admission, so the last admitted call can finish.
    const admission = metric === "prompt_admissions" || metric === "image_calls" || metric === "operation_calls";
    if (cap !== undefined && (admission ? ledger.totals[metric] > cap * scale : ledger.totals[metric] >= cap * scale)) {
      return `${metric}=${ledger.totals[metric] / scale}, ${limit}=${cap}`;
    }
  }
  return null;
}

export function checkBudget(workspace: string): BudgetLedger | null {
  const ledger = readBudget(workspace);
  if (!ledger) return null; // Template classification before a run exists.
  tick(workspace, ledger);
  const reason = exhausted(ledger);
  if (reason) event(ledger, readRunState(workspace).current_stage ?? "prepare", "exhausted", {}, { detail: reason });
  save(workspace, ledger);
  if (reason) throw new BudgetExceededError(reason);
  return ledger;
}

/** Call under the controller run lock, and pair with endBudgetRun in finally. */
export function beginBudgetRun(workspace: string): BudgetLedger | null {
  if (active.has(resolve(workspace))) return checkBudget(workspace);
  const ledger = checkBudget(workspace);
  if (!ledger) return null;
  const stage = readRunState(workspace).current_stage ?? "prepare";
  active.set(resolve(workspace), { tick: performance.now(), stage });
  event(ledger, stage, "begin", {});
  save(workspace, ledger);
  return ledger;
}

/** Never throws merely because a cap was reached; safe for a controller finally. */
export function endBudgetRun(workspace: string): BudgetLedger | null {
  const ledger = readBudget(workspace);
  if (!ledger || !active.has(resolve(workspace))) return ledger;
  tick(workspace, ledger);
  active.delete(resolve(workspace));
  event(ledger, readRunState(workspace).current_stage ?? "prepare", "end", {});
  save(workspace, ledger);
  return ledger;
}

function admit(workspace: string, kind: "prompt" | "image" | "operation", count: number, sessionId?: string): BudgetLedger | null {
  if (!Number.isSafeInteger(count) || count < 1) throw new UserFacingError("Budget admission count must be a positive safe integer");
  const ledger = checkBudget(workspace);
  if (!ledger) return null;
  const stage = readRunState(workspace).current_stage ?? "prepare";
  const metric = kind === "prompt" ? "prompt_admissions" : kind === "image" ? "image_calls" : "operation_calls";
  const limit = kind === "prompt" ? "max_model_calls" : kind === "image" ? "max_image_calls" : "max_operation_calls";
  const cap = ledger.limits[limit];
  if (cap !== undefined && ledger.totals[metric] + count > cap) {
    const detail = `${metric}=${ledger.totals[metric]}, requested=${count}, ${limit}=${cap}`;
    event(ledger, stage, "exhausted", {}, { detail, session_id: sessionId });
    save(workspace, ledger);
    throw new BudgetExceededError(detail);
  }
  event(ledger, stage, kind, { [metric]: count, ...(kind === "image" ? { unreported_image_bills: count } : {}) }, { session_id: sessionId });
  // Persist before dispatch, including failed/ambiguous API admissions.
  save(workspace, ledger);
  return ledger;
}

export function consumeBudget(workspace: string, kind: "image" | "operation", count = 1): BudgetLedger | null {
  return admit(workspace, kind, count);
}

export function consumePromptBudget(workspace: string, sessionId: string): BudgetLedger | null {
  return admit(workspace, "prompt", 1, sessionId);
}

/** Merge cumulative snapshots by high-water mark, never add a snapshot twice. */
export function recordSessionUsage(workspace: string, sessionId: string, input: Usage): BudgetLedger | null {
  const ledger = readBudget(workspace);
  if (!ledger) return null;
  const usage = UsageSchema.parse(input);
  const previous = ledger.sessions[sessionId];
  const before = previous?.usage ?? UsageSchema.parse({});
  const merged = { ...before };
  for (const key of Object.keys(usage) as Array<keyof Usage>) {
    merged[key] = Math.max(before[key] ?? 0, usage[key] ?? 0);
  }
  // Legacy callers with no cost completeness field must not imply free use.
  if (usage.unknown_cost_messages === undefined) merged.unknown_cost_messages = Math.max(before.unknown_cost_messages ?? 0, usage.model_calls);
  const stage = previous?.stage ?? readRunState(workspace).current_stage ?? "prepare";
  const tokens = (u: Usage): number => u.input_tokens + u.output_tokens + u.reasoning_tokens + u.cache_read_tokens + u.cache_write_tokens;
  const delta: Partial<Totals> = {
    assistant_messages: merged.model_calls - before.model_calls,
    total_tokens: tokens(merged) - tokens(before),
    known_cost_usd: merged.cost - before.cost,
    unknown_cost_messages: (merged.unknown_cost_messages ?? 0) - (before.unknown_cost_messages ?? 0),
  };
  ledger.sessions[sessionId] = { stage, usage: merged };
  tick(workspace, ledger);
  if (!previous || Object.values(delta).some((value) => value !== 0)) event(ledger, stage, "session_usage", delta, { session_id: sessionId });
  save(workspace, ledger); // Record over-cap usage before reporting exhaustion.
  const reason = exhausted(ledger);
  if (reason) {
    event(ledger, stage, "exhausted", {}, { detail: reason, session_id: sessionId });
    save(workspace, ledger);
    throw new BudgetExceededError(reason);
  }
  return ledger;
}

export function recordBudgetFailure(workspace: string, sessionId: string, detail: string, usageUnknown = false): void {
  const ledger = readBudget(workspace);
  if (!ledger) return;
  tick(workspace, ledger);
  event(ledger, readRunState(workspace).current_stage ?? "prepare", "failure", usageUnknown ? { unknown_usage_events: 1 } : {}, { session_id: sessionId, detail });
  save(workspace, ledger);
}
