import test from "node:test";
import assert from "node:assert/strict";
import { OutlineSchema } from "../dist/artifacts.js";
import {
  LiteratureRetrievalError, parseLkmSearchOutput, retrieveLiterature,
  retrieveLiteratureFollowup, mergeCandidates, assignCitationKeys,
} from "../dist/literature.js";
import { mergeSeedBibliography } from "../dist/bibliography.js";
import { plannedCitationCount, planQueries, tidyQuery } from "../dist/queries.js";
import { gateByRelevance } from "../dist/relevance.js";

const outline = (hints = [], keys = []) => OutlineSchema.parse({
  intro_related_work_plan: { introduction_strategy: { hook_hypothesis: "audio visual segmentation" } },
  section_plan: [{ section_title: "Experiments", subsections: [{
    subsection_title: "Evaluation", citation_hints: hints, citation_candidates: keys,
  }] }],
});
const paper = (title = "Audio visual segmentation", extra = {}) => ({
  id: title, en_title: title, en_abstract: "Audio visual segmentation experiments.",
  authors: "Jane Doe", publication_date: "2024-01", ...extra,
});
const options = (extra = {}) => ({ cutoff: "2025", maxCalls: 2, enrich: false, ...extra });
const candidate = (title, key, extra = {}) => ({
  title, citation_key: key, provider: "bohrium_lkm", provider_id: title,
  retrieved_at: "2026-01-01", authors: ["Jane Doe"], year: "2024", venue: "",
  abstract: "full evidence", doi: "", matched_queries: [], relevance: 0, anchor: null, ...extra,
});

test("LKM empty success is distinct from failed or malformed output", () => {
  assert.deepEqual(parseLkmSearchOutput('progress\n{"ok":true,"data":{"papers":{}}}'), []);
  assert.equal(parseLkmSearchOutput(JSON.stringify({ ok: true, data: { papers: { one: paper() } } })).length, 1);
  for (const output of ["not JSON", '{"ok":false,"data":{"papers":{}}}',
    '{"ok":true,"data":{}}', '{"ok":true,"data":{"code":1,"papers":{}}}',
    '{"ok":true,"data":{"papers":{"one":null}}}']) {
    assert.throws(() => parseLkmSearchOutput(output));
  }
});

test("partial search failures throw with reusable successes and call accounting", async () => {
  let failure;
  await assert.rejects(retrieveLiterature(options({ queries: ["bad", "good"], search: async (query) => {
    if (query === "bad") throw new Error("private diagnostic must not escape");
    return [paper()];
  } })), (error) => {
    assert.ok(error instanceof LiteratureRetrievalError);
    failure = error.result;
    assert.equal(failure.callsMade, 2);
    assert.equal(failure.candidates.length, 1);
    assert.deepEqual(failure.completedQueries, ["good"]);
    assert.deepEqual(failure.pendingQueries, ["bad"]);
    assert.deepEqual(failure.perQuery.map((q) => q.status), ["failed", "success"]);
    assert.ok(!JSON.stringify(failure).includes("private diagnostic"));
    return true;
  });
  const calls = [];
  const resumed = await retrieveLiterature(options({ queries: ["bad", "good"],
    previousCandidates: failure.candidates, previousQueries: failure.completedQueries, cache: failure.cache,
    search: async (query) => { calls.push(query); return []; },
  }));
  assert.deepEqual(calls, ["bad"]);
  assert.equal(resumed.candidates[0].citation_key, failure.candidates[0].citation_key);
});

test("all failures cannot masquerade as empty search success", async () => {
  await assert.rejects(retrieveLiterature(options({ queries: ["bad"], search: async () => { throw new Error(); } })),
    LiteratureRetrievalError);
  const empty = await retrieveLiterature(options({ queries: ["empty"], search: async () => [] }));
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.failures, []);
  assert.equal(empty.perQuery[0].status, "success");
});

test("all-zero relevance is rejected unless a citation anchor rescues it", () => {
  const pool = [candidate("Banana farming", "banana"), candidate("Mask2Former", "mask")];
  const gate = gateByRelevance(pool, outline(["Mask2Former"]));
  assert.deepEqual(gate.admitted.map((c) => c.citation_key), ["mask"]);
  assert.equal(gate.anchorRescued, 1);
  assert.equal(gateByRelevance(pool, OutlineSchema.parse({})).admitted.length, 0);
  assert.equal(gateByRelevance(pool, outline(), { fraction: 0 }).admitted.length, 0);
});

test("hint/key representations do not double count adaptive demand", () => {
  assert.equal(plannedCitationCount(outline(["AdamW", "research paper introducing 'AdamW'", "ResNet"], ["a", "r"])), 2);
  assert.equal(plannedCitationCount(outline([], ["a", "a", "b", "c"])), 3);
});

test("generic dependencies are contextualized, not discarded", () => {
  const plan = planQueries(outline(["AdamW", "Jaccard index", "cross attention"]));
  assert.equal(plan.queries.length, 3);
  assert.ok(plan.queries.every((q) => q.includes("audio visual segmentation")));
  assert.ok(plan.decisions.every((d) => d.action === "contextualized"));
});

test("narrative citation instructions become topical queries without losing demands", () => {
  const hints = [
    "Cite the core weak-field Kerr source retrieved by the controller only if needed for the framing.",
    "Use independently retrieved weak-field Kerr and light-bending sources; do not cite inherited files.",
    "Cite numerical-method and near-critical-scope sources only where those claims appear.",
    "Cite a numerical integration reference only for general method context; all settings come from source/check.py.",
    "Cite relevant Kerr geodesic or quadrature methodology if independently retrieved.",
  ];
  const plan = planQueries(outline(hints));
  assert.deepEqual(plan.queries, ["weak-field Kerr", "weak-field Kerr and light-bending",
    "numerical-method and near-critical-scope", "numerical integration", "Kerr geodesic or quadrature methodology"]);
  assert.ok(plan.decisions.every((decision) => decision.action === "contextualized"));
  assert.equal(planQueries(outline(["Use only the minimum relevant prior-work citations needed for the argument."])).queries.length, 1);
  assert.equal(tidyQuery("Kerr light bending. Identify the canonical formulas and convention choices."), "Kerr light bending");
});

test("full abstracts survive retrieval; duplicate queries cost only one call", async () => {
  const abstract = "Evidence ".repeat(500);
  let calls = 0;
  const result = await retrieveLiterature(options({ queries: ["topic", " TOPIC "], search: async () => {
    calls++; return [paper(undefined, { en_abstract: abstract })];
  } }));
  assert.equal(calls, 1);
  assert.equal(result.candidates[0].abstract, abstract.trim());
});

test("cache replay is free, retains timestamps, and still applies cutoff", async () => {
  const first = await retrieveLiterature(options({ queries: ["topic"], search: async () => [paper()] }));
  const cache = JSON.parse(JSON.stringify(first.cache));
  const replay = await retrieveLiterature(options({ queries: ["topic", "new"], maxCalls: 0, cache,
    search: async () => assert.fail("must not call transport"),
  }));
  assert.equal(replay.callsMade, 0);
  assert.deepEqual(replay.candidates, first.candidates);
  assert.equal(replay.perQuery[0].status, "cached");
  assert.deepEqual(replay.pendingQueries, ["new"]);
  const older = await retrieveLiterature(options({ queries: ["topic"], cutoff: "2023", maxCalls: 0, cache }));
  assert.equal(older.candidates.length, 0);
  assert.equal(older.dropped.anachronistic, 1);
});

test("targeted followup respects remaining budget and preserves published keys", async () => {
  const previous = candidate("Audio visual segmentation", "published-key");
  const result = await retrieveLiteratureFollowup(options({
    outline: outline(), uncoveredTopics: ["old", "audio visual segmentation", "another topic"],
    previousCandidates: [previous], previousQueries: ["old"], maxCalls: 1,
    search: async () => [paper(), paper("Audio visual segmentation improvements")],
  }));
  assert.equal(result.callsMade, 1);
  assert.deepEqual(result.pendingQueries, ["another topic"]);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.find((c) => c.title === previous.title).citation_key, "published-key");
  assert.equal(previous.matched_queries.length, 0);
});

test("seed merge preserves raw content, deduplicates DOI/title, and resolves key collisions", () => {
  const seed = '% author comment\n@string{venue = "Conference"}\n@article{KeepMe,\n title={Protected {Title}},\n doi={https://doi.org/10.123/ABC},\n custom={Do not rewrite}\n}\n';
  const merged = mergeSeedBibliography(seed, [
    candidate("Different provider title", "other", { doi: "10.123/abc" }),
    candidate("Protected Title", "duplicate"),
    candidate("New result", "KeepMe"),
  ], "2026-01-01");
  assert.ok(merged.bibtex.startsWith(seed));
  assert.equal(merged.candidates.length, 2);
  assert.deepEqual(merged.candidates.map((c) => c.citation_key), ["KeepMe", "KeepMe_1"]);
  assert.ok(merged.bibtex.includes("@inproceedings{KeepMe_1,"));
  assert.equal(mergeSeedBibliography(seed, [], "2026-01-01").bibtex, seed);
  const again = mergeSeedBibliography(seed, merged.candidates, "2026-01-01");
  assert.equal(again.bibtex, merged.bibtex);
});

test("merge deduplicates provider identity without mutating published metadata", () => {
  const original = candidate("Original", "stable", { provider_id: "123" });
  const merged = mergeCandidates([original], [candidate("Updated", "new", { provider_id: "123", matched_queries: ["q"] })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Original");
  assert.deepEqual(merged[0].matched_queries, ["q"]);
  assert.deepEqual(original.matched_queries, []);
});

test("large key collision sets stay unique and BibTeX-safe", () => {
  const records = Array.from({ length: 40 }, (_, i) => candidate(`Shared prefix ${i}`, "ignored"));
  const keyed = assignCitationKeys(records);
  assert.equal(new Set(keyed.map((c) => c.citation_key)).size, 40);
  assert.ok(keyed.every((c) => /^[A-Za-z0-9_]+$/.test(c.citation_key)));
});

test("invalid budgets fail before any transport call", async () => {
  for (const maxCalls of [-1, 0.5, NaN, Infinity]) {
    await assert.rejects(retrieveLiterature(options({ queries: ["q"], maxCalls,
      search: async () => assert.fail("invalid budget must not call transport"),
    })), RangeError);
  }
});
