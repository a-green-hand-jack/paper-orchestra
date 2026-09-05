import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CandidatesSchema, OutlineSchema } from "./artifacts.js";
import { mergeSeedBibliography, suppliedBibliography, toSuppliedCandidates } from "./bibliography.js";
import { UserFacingError } from "./errors.js";
import { ensureDir, readJson, writeJsonAtomic } from "./files.js";
import {
  LKM_CALL_PRICE_CNY, LiteratureRetrievalError, retrieveLiterature,
  toBibtex, toCitationMap, type RetrievalResult, type RetrievalOptions,
} from "./literature.js";
import { ARTIFACTS, paths } from "./paths.js";
import { planQueries } from "./queries.js";
import type { RunState } from "./state/schema.js";

const PaperField = z.string().nullish().transform((value) => value ?? undefined);
const PaperSchema = z.object({
  id: PaperField, en_title: PaperField, zh_title: PaperField, en_abstract: PaperField,
  authors: PaperField, doi: PaperField, publication_name: PaperField,
  cover_date_start: PaperField, publication_date: PaperField,
});

const CacheSchema = z.object({
  callsMade: z.number().int().nonnegative(),
  initialCallsMade: z.number().int().nonnegative().optional(),
  candidates: CandidatesSchema,
  completedQueries: z.array(z.string()),
  cache: z.record(z.object({ papers: z.array(PaperSchema), retrievedAt: z.string().min(1) })),
  pending: z.array(z.string()).default([]),
  perQuery: z.array(z.object({
    query: z.string(), retrieved: z.number().int().nonnegative(), admitted: z.number().int().nonnegative(),
    status: z.enum(["success", "cached", "failed"]),
  })).default([]),
  failures: z.array(z.object({ query: z.string(), message: z.string() })).default([]),
});

export class UnmetLiteratureError extends UserFacingError {
  readonly gaps: readonly string[];

  constructor(gaps: readonly string[], message: string) {
    super(message);
    this.name = "UnmetLiteratureError";
    this.gaps = [...gaps];
  }
}

function initialCallLimit(totalBudget: number): number {
  return totalBudget - (totalBudget > 1 ? Math.ceil(totalBudget / 4) : 0);
}

/** Read-only preflight check: the initial phase needs no further paid search.
 * This is not evidence that follow-up citation gaps have been satisfied.
 */
export function initialRetrievalSatisfied(workspace: string, state: RunState): boolean {
  try {
    if (state.scope.bibliography_mode === "closed") return suppliedBibliography(workspace) !== null;
    const totalBudget = state.scope.max_lkm_calls;
    if (!Number.isSafeInteger(totalBudget) || totalBudget < 0) return false;
    const saved = CacheSchema.parse(readJson(join(paths(workspace).runDir, "literature-cache.json")));
    const initialCalls = saved.initialCallsMade ?? saved.callsMade;
    if (initialCalls > saved.callsMade || saved.candidates.length === 0 || saved.failures.length > 0) return false;
    const outline = OutlineSchema.parse(readJson(join(workspace, ARTIFACTS.outline)));
    if (initialCalls >= initialCallLimit(totalBudget) || saved.callsMade >= totalBudget) return true;
    const completed = new Set(saved.completedQueries.map((query) => query.trim().toLowerCase().replace(/\s+/g, " ")));
    return planQueries(outline).queries.every((query) => {
      const id = query.trim().toLowerCase().replace(/\s+/g, " ");
      return completed.has(id) || Boolean(saved.cache[JSON.stringify([id, 10, "abstract,conclusion"])]);
    });
  } catch {
    // An unreadable checkpoint cannot waive authorization or capability checks.
    return false;
  }
}

/** Controller-owned retrieval, accounting, and publication; no model-side network access. */
export async function retrieveForLiterature(
  options: { workspace: string; allowLkmSpend?: boolean; onEvent?: (line: string) => void;
    /** Offline test transport; production uses the default LKM CLI. */
    search?: RetrievalOptions["search"] },
  state: RunState,
  uncoveredTopics?: readonly string[],
): Promise<number> {
  const { workspace } = options;
  const say = options.onEvent ?? ((line: string) => process.stdout.write(`${line}\n`));
  const mode = state.scope.bibliography_mode ?? "seed";
  const followup = uncoveredTopics !== undefined;
  const totalBudget = state.scope.max_lkm_calls;
  if (!Number.isSafeInteger(totalBudget) || totalBudget < 0) {
    throw new UserFacingError("literature retrieval requires a nonnegative integer max_lkm_calls");
  }
  const reserve = totalBudget - initialCallLimit(totalBudget);
  const cachePath = join(paths(workspace).runDir, "literature-cache.json");
  let saved: z.infer<typeof CacheSchema> = {
    callsMade: 0, initialCallsMade: 0, candidates: [], completedQueries: [], cache: {},
    pending: [], perQuery: [], failures: [],
  };
  if (existsSync(cachePath)) {
    try {
      saved = CacheSchema.parse(readJson(cachePath));
      saved.initialCallsMade ??= saved.callsMade;
      if (saved.initialCallsMade > saved.callsMade) throw new Error("inconsistent accounting");
    } catch {
      throw new UserFacingError("literature-cache.json is invalid; refusing to reset spend accounting or repeat paid queries");
    }
  }
  const suppliedRel = suppliedBibliography(workspace);
  const seed = suppliedRel ? readFileSync(join(workspace, suppliedRel), "utf8") : null;
  const ingestedAt = saved.candidates.find((candidate) => candidate.provider === "supplied")?.retrieved_at ??
    new Date().toISOString();
  const publish = (): void => {
    const merged = seed === null
      ? { candidates: saved.candidates, bibtex: toBibtex(saved.candidates) }
      : mergeSeedBibliography(seed, saved.candidates, ingestedAt);
    saved.candidates = merged.candidates;
    // Persist spend/results before publishing derived files, so a publication
    // failure can be resumed without repeating successful paid searches.
    writeJsonAtomic(cachePath, saved);
    ensureDir(paths(workspace).brainRaw);
    writeFileSync(join(workspace, ARTIFACTS.references), merged.bibtex, "utf8");
    writeJsonAtomic(join(workspace, ARTIFACTS.candidates), merged.candidates);
    writeJsonAtomic(join(workspace, ARTIFACTS.citationMap), toCitationMap(merged.candidates));
  };
  const provenance = (decisions: ReturnType<typeof planQueries>["decisions"], status: string): void => {
    writeJsonAtomic(join(workspace, ARTIFACTS.queryPlan), {
      generated_at: new Date().toISOString(), mode, phase: followup ? "followup" : "initial", status,
      supplied_path: suppliedRel, decisions, callsMade: saved.callsMade,
      cumulative_cost_cny: Number((saved.callsMade * LKM_CALL_PRICE_CNY).toFixed(2)),
      max_calls: totalBudget, initial_calls_made: saved.initialCallsMade,
      followup_reserved_calls: reserve, remaining_calls: Math.max(0, totalBudget - saved.callsMade),
      completedQueries: saved.completedQueries, pending: saved.pending,
      perQuery: saved.perQuery, failures: saved.failures,
    });
  };

  if (mode === "closed") {
    if (seed === null) throw new UserFacingError("closed bibliography mode requires an author-supplied .bib file; no retrieval is permitted");
    saved.candidates = toSuppliedCandidates(seed, ingestedAt);
    publish();
    provenance([], "closed");
    say(`   closed bibliography: ${saved.candidates.length} source(s), no additional LKM calls`);
    if (uncoveredTopics?.some((topic) => topic.trim())) {
      throw new UserFacingError("citation gaps remain, but closed bibliography mode forbids additional retrieval; resolve them within the supplied bibliography");
    }
    return saved.candidates.length;
  }

  // Prefer the literature-updated outline for gap searches; the initial plan
  // remains authoritative for initial retrieval and its resume.
  const outlinePath = join(workspace, followup && existsSync(join(workspace, ARTIFACTS.outlineV1))
    ? ARTIFACTS.outlineV1 : ARTIFACTS.outline);
  let outline;
  try {
    outline = OutlineSchema.parse(readJson(outlinePath));
  } catch {
    throw new UserFacingError(`cannot retrieve literature: ${outlinePath} is missing or invalid; re-run the outline stage`);
  }
  const planned = planQueries(outline, uncoveredTopics);
  const id = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, " ");
  // Older checkpoints contain literal writer instructions. Alias their successful
  // searches to the sanitized query without repaying or losing failure retries.
  const canonical = (query: string): string => planQueries(outline, [query]).queries[0] ?? query;
  saved.completedQueries = [...new Set(saved.completedQueries.map(canonical))];
  saved.pending = saved.pending.map(canonical);
  saved.failures = saved.failures.map((entry) => ({ ...entry, query: canonical(entry.query) }));
  for (const [key, value] of Object.entries(saved.cache)) {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && typeof parts[0] === "string") {
      saved.cache[JSON.stringify([id(canonical(parts[0])), ...parts.slice(1)])] ??= value;
    }
  }
  saved.candidates = saved.candidates.map((candidate) => ({ ...candidate,
    matched_queries: [...new Set([...candidate.matched_queries, ...candidate.matched_queries.map(canonical)])],
  }));
  const completed = new Set(saved.completedQueries.map(id));
  const failed = new Set(saved.failures.map((entry) => id(entry.query)));
  const queries = planned.queries.filter((query) => !completed.has(id(query)));
  // Retry failed initial queries first. Only these may draw on the reserve;
  // unrelated deferred queries must still respect the initial call limit.
  if (!followup) queries.sort((a, b) => Number(failed.has(id(b))) - Number(failed.has(id(a))));
  saved.pending = [...new Map([...saved.pending, ...queries]
    .filter((query) => !completed.has(id(query))).map((query) => [id(query), query])).values()];
  const remaining = Math.max(0, totalBudget - saved.callsMade);
  const uncached = queries.filter((query) => !saved.cache[JSON.stringify([id(query), 10, "abstract,conclusion"])]);
  const allowance = followup ? remaining : Math.min(remaining, Math.max(
    0, initialCallLimit(totalBudget) - (saved.initialCallsMade ?? 0),
    uncached.filter((query) => failed.has(id(query))).length,
  ));
  const calls = Math.min(allowance, uncached.length);
  publish();
  provenance(planned.decisions, "planned");
  if (calls > 0 && state.scope.network_policy === "offline") {
    provenance(planned.decisions, "blocked_offline");
    throw new UserFacingError("offline network policy forbids the literature searches needed for this run; cached results were preserved");
  }
  if (calls > 0 && !options.allowLkmSpend) {
    provenance(planned.decisions, "blocked_authorization");
    throw new UserFacingError(`literature retrieval needs up to ${calls} LKM call(s), approximately ` +
      `${(calls * LKM_CALL_PRICE_CNY).toFixed(2)} CNY; authorize with --allow-lkm-spend`);
  }

  let failure: LiteratureRetrievalError | undefined;
  let attemptQueries = queries;
  let attemptCalls = calls;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: RetrievalResult;
    failure = undefined;
    try {
      result = await retrieveLiterature({
        queries: attemptQueries, cutoff: state.scope.research_cutoff, outline, maxCalls: attemptCalls,
        previousCandidates: saved.candidates, previousQueries: saved.completedQueries, cache: saved.cache,
        enrich: state.scope.network_policy !== "offline", onProgress: say, search: options.search,
      });
    } catch (error) {
      if (!(error instanceof LiteratureRetrievalError)) throw error;
      failure = error;
      result = error.result;
    }
    saved.callsMade += result.callsMade;
    if (!followup) saved.initialCallsMade = (saved.initialCallsMade ?? 0) + result.callsMade;
    saved.candidates = result.candidates;
    saved.completedQueries = result.completedQueries;
    saved.cache = result.cache;
    saved.perQuery.push(...result.perQuery);
    const nowCompleted = new Set(saved.completedQueries.map(id));
    saved.pending = [...new Map([...saved.pending, ...result.pendingQueries]
      .filter((query) => !nowCompleted.has(id(query))).map((query) => [id(query), query])).values()];
    saved.failures = [...saved.failures.filter((entry) =>
      !result.perQuery.some((query) => id(query.query) === id(entry.query))), ...result.failures];
    publish();
    provenance(planned.decisions, failure ? "search_failed" : "retrieved");
    if (!failure || followup || attempt > 0 || saved.callsMade >= totalBudget ||
        !options.allowLkmSpend || state.scope.network_policy === "offline") break;
    attemptQueries = result.failures.map((entry) => entry.query);
    attemptCalls = Math.min(attemptQueries.length, totalBudget - saved.callsMade);
    say(`   retrying ${attemptCalls} failed initial LKM query(ies) once within the remaining budget`);
  }
  if (failure) throw failure;
  if (saved.failures.length > 0) {
    provenance(planned.decisions, "search_failed");
    throw new UserFacingError("previous literature searches still have unresolved failures; their pending queries and cumulative spend were preserved");
  }

  const unmet = followup ? planned.queries.filter((query) =>
    !saved.candidates.some((candidate) => candidate.matched_queries.some((matched) => id(matched) === id(query)))) : [];
  if (unmet.length > 0) {
    provenance(planned.decisions, "unmet_gaps");
    const gaps = planned.decisions.filter((decision) => decision.query !== null && unmet.includes(decision.query))
      .map((decision) => decision.original);
    throw new UnmetLiteratureError(gaps, `literature follow-up has ${gaps.length} unmet citation gap(s): ${gaps.join("; ")}. ` +
      (saved.callsMade >= totalBudget ? "The LKM call budget is exhausted; cached sources do not cover these gaps."
        : "Searches supplied no admitted evidence; revise the targeted queries before retrying."));
  }
  if (saved.candidates.length === 0) {
    provenance(planned.decisions, "no_sources");
    throw new UserFacingError("literature retrieval produced no relevant sources; review the outline queries, cutoff, and remaining call budget");
  }
  say(`   literature: ${saved.candidates.length} source(s), ${saved.callsMade}/${totalBudget} cumulative LKM calls ` +
    `(~${(saved.callsMade * LKM_CALL_PRICE_CNY).toFixed(2)} CNY), ${saved.pending.length} pending query(ies)`);
  return saved.candidates.length;
}
