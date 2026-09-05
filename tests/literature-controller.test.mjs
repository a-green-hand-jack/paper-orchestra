import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { retrieveForLiterature, initialRetrievalSatisfied, UnmetLiteratureError } from "../dist/literature-controller.js";
import { UserFacingError } from "../dist/errors.js";
import { LiteratureRetrievalError } from "../dist/literature.js";
import { ARTIFACTS } from "../dist/paths.js";

const seed = '% preserve author content\n@article{AuthorKey, title={Audio visual segmentation}, year={2024}, custom={original}}\n';
const source = {
  citation_key: "StableKey", title: "Audio visual segmentation experiments", provider: "bohrium_lkm",
  provider_id: "stable-provider-id", retrieved_at: "2026-01-01", authors: ["Jane Doe"],
  venue: "", year: "2024", abstract: "Audio visual segmentation evidence.", doi: "",
  relevance: 0.8, anchor: null, matched_queries: ["existing topic"],
};
const cacheKey = (query) => JSON.stringify([query.toLowerCase(), 10, "abstract,conclusion"]);
const response = { papers: [{ id: "new-id", en_title: "Audio visual segmentation benchmark",
  en_abstract: "Audio visual segmentation benchmark evidence.", authors: "Jane Doe", publication_date: "2024-01" }],
  retrievedAt: "2026-01-01" };

function fixture(t, { mode = "seed", maxCalls = 8, bib = null, queries = ["existing topic"], saved } = {}) {
  const workspace = mkdtempSync("/tmp/opencode/literature-controller-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "source"));
  mkdirSync(join(workspace, ".po-run"));
  mkdirSync(join(workspace, ".brain", "raw"), { recursive: true });
  if (bib !== null) writeFileSync(join(workspace, "source", "references.bib"), bib);
  writeFileSync(join(workspace, ARTIFACTS.outline), JSON.stringify({
    intro_related_work_plan: { introduction_strategy: { hook_hypothesis: "audio visual segmentation",
      search_directions: queries } },
  }));
  const checkpoint = { callsMade: 1, initialCallsMade: 1, candidates: [source],
    completedQueries: ["existing topic"], cache: {}, pending: [], ...saved };
  if (saved !== null) writeFileSync(join(workspace, ".po-run", "literature-cache.json"), JSON.stringify(checkpoint));
  const state = { scope: { bibliography_mode: mode, max_lkm_calls: maxCalls,
    research_cutoff: "2025-01", network_policy: "offline" } };
  return { workspace, state, options: { workspace, onEvent() {} },
    read: (path) => JSON.parse(readFileSync(join(workspace, path), "utf8")),
    checkpoint: () => JSON.parse(readFileSync(join(workspace, ".po-run", "literature-cache.json"), "utf8")),
  };
}

test("closed bibliography publishes raw supplied content without outline or network", async (t) => {
  const f = fixture(t, { mode: "closed", bib: seed, saved: null });
  rmSync(join(f.workspace, ARTIFACTS.outline));
  assert.equal(await retrieveForLiterature(f.options, f.state), 1);
  assert.equal(readFileSync(join(f.workspace, ARTIFACTS.references), "utf8"), seed);
  assert.deepEqual(Object.keys(f.read(ARTIFACTS.citationMap)), ["AuthorKey"]);
  assert.equal(f.checkpoint().callsMade, 0);
  assert.equal(f.read(ARTIFACTS.queryPlan).mode, "closed");
  assert.equal(f.read(ARTIFACTS.queryPlan).cumulative_cost_cny, 0);
});

test("closed mode rejects new gaps without spending or discarding supplied sources", async (t) => {
  const f = fixture(t, { mode: "closed", bib: seed, saved: null });
  await assert.rejects(retrieveForLiterature(f.options, f.state, ["missing dependency"]), /closed bibliography mode forbids/);
  assert.equal(f.checkpoint().callsMade, 0);
  assert.equal(f.read(ARTIFACTS.candidates).length, 1);
});

test("closed mode without a supplied bibliography does not fall back to search", async (t) => {
  const f = fixture(t, { mode: "closed", saved: null });
  await assert.rejects(retrieveForLiterature(f.options, f.state), /requires an author-supplied/);
});

test("initial resume republishes successful cached candidates without authorization or repayment", async (t) => {
  const f = fixture(t);
  assert.equal(await retrieveForLiterature(f.options, f.state), 1);
  assert.equal(await retrieveForLiterature(f.options, f.state), 1);
  assert.equal(f.checkpoint().callsMade, 1);
  assert.equal(f.read(ARTIFACTS.candidates)[0].citation_key, "StableKey");
  assert.equal(f.read(ARTIFACTS.queryPlan).cumulative_cost_cny, 0.05);
});

test("missing mode defaults to seed and supplements rather than closes supplied bibliography", async (t) => {
  const f = fixture(t, { bib: seed });
  delete f.state.scope.bibliography_mode;
  assert.equal(await retrieveForLiterature(f.options, f.state), 2);
  assert.ok(readFileSync(join(f.workspace, ARTIFACTS.references), "utf8").startsWith(seed));
  assert.deepEqual(f.read(ARTIFACTS.candidates).map((c) => c.citation_key), ["AuthorKey", "StableKey"]);
  assert.equal(f.read(ARTIFACTS.queryPlan).mode, "seed");
});

test("initial resume preserves followup reserve and pending queries", async (t) => {
  const f = fixture(t, { queries: ["existing topic", "deferred topic"],
    saved: { callsMade: 6, initialCallsMade: 6 } });
  assert.equal(await retrieveForLiterature(f.options, f.state), 1);
  assert.equal(f.checkpoint().callsMade, 6);
  assert.deepEqual(f.checkpoint().pending, ["deferred topic"]);
  const plan = f.read(ARTIFACTS.queryPlan);
  assert.equal(plan.followup_reserved_calls, 2);
  assert.equal(plan.remaining_calls, 2);
});

test("targeted followup replays raw cache offline, keeps keys and cumulative spend", async (t) => {
  const f = fixture(t, { saved: { callsMade: 7, initialCallsMade: 6,
    cache: { [cacheKey("benchmark gap")]: response }, pending: ["deferred topic"] } });
  assert.equal(await retrieveForLiterature(f.options, f.state, ["benchmark gap"]), 2);
  assert.equal(f.checkpoint().callsMade, 7);
  assert.equal(f.checkpoint().initialCallsMade, 6);
  assert.deepEqual(f.checkpoint().pending, ["deferred topic"]);
  assert.ok(f.read(ARTIFACTS.candidates).some((c) => c.citation_key === "StableKey"));
  assert.equal(f.read(ARTIFACTS.queryPlan).perQuery[0].status, "cached");
  assert.equal(await retrieveForLiterature(f.options, f.state, ["benchmark gap"]), 2);
  assert.equal(f.checkpoint().callsMade, 7);
});

test("exhausted followup reports unmet gaps, saves pending work, and preserves sources", async (t) => {
  const f = fixture(t, { saved: { callsMade: 8 } });
  await assert.rejects(retrieveForLiterature(f.options, f.state, ["new gap"]), /budget is exhausted/);
  assert.equal(f.checkpoint().callsMade, 8);
  assert.deepEqual(f.checkpoint().pending, ["new gap"]);
  assert.equal(f.read(ARTIFACTS.candidates)[0].citation_key, "StableKey");
  assert.equal(f.read(ARTIFACTS.queryPlan).status, "unmet_gaps");
});

test("completed empty search cannot satisfy a followup gap or trigger repayment", async (t) => {
  const f = fixture(t, { saved: { completedQueries: ["existing topic", "empty gap"] } });
  await assert.rejects(retrieveForLiterature(f.options, f.state, ["empty gap"]), (error) => {
    assert.ok(error instanceof UnmetLiteratureError);
    assert.ok(error instanceof UserFacingError);
    assert.deepEqual(error.gaps, ["empty gap"]);
    assert.match(error.message, /no admitted evidence/);
    return true;
  });
  assert.equal(f.checkpoint().callsMade, 1);
});

test("offline and unauthorized searches preserve pending checkpoint without calls", async (t) => {
  const f = fixture(t, { queries: ["new query"] });
  await assert.rejects(retrieveForLiterature(f.options, f.state), /offline network policy/);
  assert.deepEqual(f.checkpoint().pending, ["new query"]);
  f.state.scope.network_policy = "online";
  await assert.rejects(retrieveForLiterature(f.options, f.state), /--allow-lkm-spend/);
  assert.equal(f.checkpoint().callsMade, 1);
  assert.equal(f.read(ARTIFACTS.queryPlan).status, "blocked_authorization");
});

test("malformed checkpoint fails closed instead of resetting paid-call accounting", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, ".po-run", "literature-cache.json"), '{"callsMade":-1}');
  await assert.rejects(retrieveForLiterature(f.options, f.state), /refusing to reset spend accounting/);
});

test("failed initial queries can draw on reserve but still require authorization", async (t) => {
  const f = fixture(t, { queries: ["failed query"], saved: {
    callsMade: 6, initialCallsMade: 6, pending: ["failed query"],
    failures: [{ query: "failed query", message: "Search failed" }],
    perQuery: [{ query: "failed query", status: "failed", retrieved: 0, admitted: 0 }],
  } });
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), false);
  await assert.rejects(retrieveForLiterature(f.options, f.state), /offline network policy/);
  f.state.scope.network_policy = "online";
  await assert.rejects(retrieveForLiterature(f.options, f.state), /up to 1 LKM call/);
  assert.equal(f.checkpoint().callsMade, 6);
  assert.deepEqual(f.checkpoint().pending, ["failed query"]);
});

test("preflight recognizes initial allowance completion without spending the reserve", async (t) => {
  const f = fixture(t, { queries: ["existing topic", "deferred topic"],
    saved: { callsMade: 6, initialCallsMade: 6 } });
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), true);
  assert.equal(await retrieveForLiterature(f.options, f.state), 1);
  assert.equal(f.checkpoint().callsMade, 6);
  assert.deepEqual(f.checkpoint().pending, ["deferred topic"]);
});

test("preflight does not waive unfinished initial work or malformed caches", (t) => {
  const f = fixture(t, { queries: ["new topic"] });
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), false);
  writeFileSync(join(f.workspace, ".po-run", "literature-cache.json"), "broken JSON");
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), false);
});

test("preflight accepts completed or replayable cached queries before the allowance is used", (t) => {
  const complete = fixture(t);
  assert.equal(initialRetrievalSatisfied(complete.workspace, complete.state), true);
  const cached = fixture(t, { queries: ["cached topic"], saved: { cache: { [cacheKey("cached topic")]: response } } });
  assert.equal(initialRetrievalSatisfied(cached.workspace, cached.state), true);
});

test("cached failed-query recovery clears failure without unlocking deferred paid queries", async (t) => {
  const f = fixture(t, { queries: ["deferred topic", "failed query"], saved: {
    callsMade: 6, initialCallsMade: 6, cache: { [cacheKey("failed query")]: response },
    failures: [{ query: "failed query", message: "Search failed" }], pending: ["failed query"],
  } });
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), false);
  assert.equal(await retrieveForLiterature(f.options, f.state), 2);
  assert.equal(f.checkpoint().callsMade, 6);
  assert.deepEqual(f.checkpoint().failures, []);
  assert.deepEqual(f.checkpoint().pending, ["deferred topic"]);
  assert.equal(initialRetrievalSatisfied(f.workspace, f.state), true);
});

test("failed-query retry allowance is capped by total remaining budget", async (t) => {
  const f = fixture(t, { queries: ["deferred", "failed one", "failed two"], saved: {
    callsMade: 7, initialCallsMade: 7,
    failures: ["failed one", "failed two"].map((query) => ({ query, message: "Search failed" })),
  } });
  f.state.scope.network_policy = "online";
  await assert.rejects(retrieveForLiterature(f.options, f.state), /up to 1 LKM call/);
  assert.equal(f.checkpoint().callsMade, 7);
  const saved = f.checkpoint();
  saved.callsMade = saved.initialCallsMade = 8;
  writeFileSync(join(f.workspace, ".po-run", "literature-cache.json"), JSON.stringify(saved));
  await assert.rejects(retrieveForLiterature(f.options, f.state), /unresolved failures/);
  assert.equal(f.checkpoint().callsMade, 8);
});

test("unmet errors preserve original topics and permit revised cached followup", async (t) => {
  const f = fixture(t, { saved: { cache: {
    [cacheKey("AdamW foundational paper audio visual segmentation")]: { papers: [], retrievedAt: "2026-01-01" },
    [cacheKey("revised optimizer search")]: response,
  } } });
  await assert.rejects(retrieveForLiterature(f.options, f.state, ["AdamW"]), (error) => {
    assert.ok(error instanceof UnmetLiteratureError);
    assert.deepEqual(error.gaps, ["AdamW"]);
    return true;
  });
  assert.equal(await retrieveForLiterature(f.options, f.state, ["revised optimizer search"]), 2);
  assert.equal(f.checkpoint().callsMade, 1);
});

test("initial transient failure retries once automatically and checkpoints cumulative spend", async (t) => {
  const f = fixture(t, { maxCalls: 10, queries: ["good query", "transient query", "deferred query"],
    saved: { callsMade: 5, initialCallsMade: 5 } });
  f.state.scope.network_policy = "online";
  const calls = [];
  const search = async (query) => {
    calls.push(query);
    if (query === "transient query" && calls.length === 2) throw new Error("transient transport failure");
    if (calls.length === 3) {
      assert.equal(f.checkpoint().callsMade, 7);
      assert.equal(f.checkpoint().failures.length, 1);
      assert.equal(f.checkpoint().candidates.length, 2);
    }
    return response.papers;
  };
  assert.equal(await retrieveForLiterature({ ...f.options, allowLkmSpend: true, search }, f.state), 2);
  assert.deepEqual(calls, ["good query", "transient query", "transient query"]);
  assert.equal(f.checkpoint().callsMade, 8);
  assert.equal(f.checkpoint().initialCallsMade, 8);
  assert.deepEqual(f.checkpoint().failures, []);
  assert.deepEqual(f.checkpoint().pending, ["deferred query"]);
  assert.equal(f.read(ARTIFACTS.queryPlan).cumulative_cost_cny, 0.4);
  assert.deepEqual(f.read(ARTIFACTS.queryPlan).perQuery.map((q) => q.status), ["success", "failed", "success"]);
});

test("persistent transport failure stops after one retry and remains a retrieval error", async (t) => {
  const f = fixture(t, { maxCalls: 10, queries: ["bad query"], saved: { callsMade: 6, initialCallsMade: 6 } });
  f.state.scope.network_policy = "online";
  let calls = 0;
  await assert.rejects(retrieveForLiterature({ ...f.options, allowLkmSpend: true,
    search: async () => { calls++; throw new Error("unavailable"); },
  }, f.state), LiteratureRetrievalError);
  assert.equal(calls, 2);
  assert.equal(f.checkpoint().callsMade, 8);
  assert.deepEqual(f.checkpoint().pending, ["bad query"]);
  assert.equal(f.checkpoint().candidates[0].citation_key, "StableKey");
});

test("automatic retries cannot exceed the total budget", async (t) => {
  const f = fixture(t, { queries: ["bad query"], saved: { callsMade: 7, initialCallsMade: 7,
    failures: [{ query: "bad query", message: "previous failure" }] } });
  f.state.scope.network_policy = "online";
  let calls = 0;
  await assert.rejects(retrieveForLiterature({ ...f.options, allowLkmSpend: true,
    search: async () => { calls++; throw new Error("unavailable"); },
  }, f.state), LiteratureRetrievalError);
  assert.equal(calls, 1);
  assert.equal(f.checkpoint().callsMade, 8);
});

test("legacy narrative checkpoints resume sanitized failures without repaying successes", async (t) => {
  const good = "Use independently retrieved weak-field Kerr and light-bending sources; do not cite inherited files.";
  const bad = "Cite numerical-method and near-critical-scope sources only where those claims appear.";
  const f = fixture(t, { maxCalls: 10, queries: [good, bad], saved: {
    callsMade: 7, initialCallsMade: 7, completedQueries: [good],
    cache: { [cacheKey(good)]: response }, failures: [{ query: bad, message: "transport failure" }], pending: [bad],
  } });
  f.state.scope.network_policy = "online";
  const calls = [];
  await retrieveForLiterature({ ...f.options, allowLkmSpend: true,
    search: async (query) => { calls.push(query); return response.papers; },
  }, f.state);
  assert.deepEqual(calls, ["numerical-method and near-critical-scope"]);
  assert.equal(f.checkpoint().callsMade, 8);
  assert.deepEqual(f.checkpoint().failures, []);
});
