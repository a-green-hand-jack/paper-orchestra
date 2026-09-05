import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ColumnVerificationSchema, OutlineSchema, TableSpecSchema, MaterialsMapSchema, ManuscriptReviewSchema } from "../dist/artifacts.js";
import { publishTables } from "../dist/presentation.js";
import { ScopeSchema } from "../dist/state/schema.js";
import { digestValue } from "../dist/files.js";
import { buildStagePrompt } from "../dist/prompts.js";
import { buildTemplateSelectionPrompt, resolveTemplateSelection } from "../dist/template-selection.js";
import { STAGES } from "../dist/stages.js";

const root = resolve(import.meta.dirname, "..");
const baseScope = { plan: [...STAGES], use_plotting: true, research_cutoff: "2026-09",
  venue: "iclr2025", network_policy: "offline", max_lkm_calls: 40 };

function fixture(t) {
  const dir = mkdtempSync("/tmp/opencode/po-contracts-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ["source", ".brain/input", ".brain/raw", ".brain/manuscript/figures", ".brain/manuscript/tables", "template", ".opencode/commands"]) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  cpSync(join(root, "dist/assets/commands"), join(dir, ".opencode/commands"), { recursive: true });
  writeFileSync(join(dir, "source/BRIEF.md"), "Target ICLR 2025. Explain limitations and use eight pages.\n");
  writeFileSync(join(dir, "source/results.json"), '{"accuracy":81.2}\n');
  return dir;
}

test("scope preserves adaptive citations, explicit bibliography modes and shipped digests", () => {
  const parsed = ScopeSchema.parse(baseScope);
  assert.equal(parsed.target_citations, undefined);
  assert.equal(digestValue(parsed), digestValue(baseScope));
  for (const bibliography_mode of ["seed", "closed"]) {
    assert.equal(ScopeSchema.parse({ ...baseScope, bibliography_mode }).bibliography_mode, bibliography_mode);
  }
  assert.equal(ScopeSchema.parse({ ...baseScope, target_citations: 7 }).target_citations, 7);
  assert.equal(ScopeSchema.safeParse({ ...baseScope, bibliography_mode: "open" }).success, false);
  assert.equal(ScopeSchema.safeParse({ ...baseScope, target_citations: NaN }).success, false);
});

const table = {
  table_id: "tab_main", title: "Main results", caption: "Held-out evaluation", section: "Experiments",
  columns: ["Accuracy (%)", "Latency (ms)"],
  rows: [{ label: "Method A", values: [81.2, null], source_paths: ["source/results.json"] }],
  source_paths: ["source/results.json"], calculation: "",
};

test("table plans preserve actual ordered values, missing measurements and provenance", () => {
  const outline = OutlineSchema.parse({ table_plan: [table], research_claims: [
    { claim: "Recorded accuracy is 81.2%", evidence_paths: ["source/results.json"], limitations: ["Single split"] },
  ], requirements: [{ requirement: "Eight pages", source: "brief", verification: "Count main-text PDF pages" }] });
  assert.deepEqual(outline.table_plan[0], table);
  assert.deepEqual(outline.plotting_plan, []);
  assert.equal(outline.research_claims[0].limitations[0], "Single split");
  assert.equal(TableSpecSchema.safeParse({ ...table, rows: [{ ...table.rows[0], values: [81.2] }] }).success, false);
  assert.equal(TableSpecSchema.safeParse({ ...table, table_id: "../overwrite" }).success, false);
  assert.equal(TableSpecSchema.safeParse({ ...table, source_paths: [] }).success, false);
  assert.equal(TableSpecSchema.safeParse({ ...table, rows: [{ ...table.rows[0], values: [Infinity, null] }] }).success, false);
});

test("existing outline shapes and universal triage extensions remain usable", () => {
  const outline = OutlineSchema.parse({ section_plan: [{ section_title: "Method", subsections: ["Implementation"] }] });
  assert.equal(outline.section_plan[0].subsections[0].subsection_title, "Implementation");
  assert.deepEqual(outline.table_plan, []);
  const materials = MaterialsMapSchema.parse({ reading: [{ path: "source/results.json", contributes: "Held-out accuracy" }],
    coverage: [{ path: "source/results.json", status: "read", reason: "Read original result" }],
    requirements: [{ requirement: "Limitations", source: "brief", verification: "Check discussion" }] });
  assert.equal(materials.coverage[0].status, "read");
  assert.deepEqual(materials.facts, []);
});

test("column verification schema matches presentation operations and column alignment", () => {
  for (const operation of ["direct", "min", "max", "mean", "std", "range", "mean_std"]) {
    const spec = { selector: "/runs/*/energy", operation, decimals: 2, ddof: 1 };
    assert.deepEqual(ColumnVerificationSchema.parse(spec), spec);
    assert.deepEqual(TableSpecSchema.parse({ ...table, column_verification: [spec, null] }).column_verification, [spec, null]);
  }
  assert.deepEqual(ColumnVerificationSchema.parse({ operation: "direct" }), { operation: "direct" });
  assert.equal(TableSpecSchema.parse(table).column_verification, undefined);
  assert.equal(TableSpecSchema.safeParse({ ...table, column_verification: [null] }).success, false);
  for (const spec of [
    { operation: "median" }, { operation: "std", ddof: 2 },
    { operation: "mean", decimals: -1 }, { operation: "mean", decimals: 101 },
    { operation: "mean", decimals: 1.5 }, { operation: "direct", selector: "" },
    { operation: "mean", formula: "energy * 2" }, { selector: "energy" },
  ]) assert.equal(ColumnVerificationSchema.safeParse(spec).success, false, JSON.stringify(spec));
});

test("per-row cell verification is typed, length-aligned and never excuses invalid column defaults", () => {
  const direct = { selector: "text:alpha_z coefficients:", operation: "direct", index: 2, decimals: 14 };
  const row = { ...table.rows[0], values: [40.7070301858, null], cell_verification: [direct, null] };
  const parsed = TableSpecSchema.parse({ ...table, column_verification: [null, null], rows: [row] });
  assert.deepEqual(parsed.rows[0].cell_verification, [direct, null]);
  assert.equal(TableSpecSchema.parse(table).rows[0].cell_verification, undefined);
  assert.equal(ColumnVerificationSchema.parse({ ...direct, decimals: 100 }).decimals, 100);
  for (const cell_verification of [[direct], [direct, null, null]]) {
    const invalid = TableSpecSchema.safeParse({ ...table, rows: [{ ...row, cell_verification }] });
    assert.equal(invalid.success, false);
    assert.match(invalid.error.message, /row.cell_verification/);
    assert.match(invalid.error.issues.map((issue) => issue.message).join("; "), /"index":2/);
  }
  const invalidColumns = TableSpecSchema.safeParse({ ...table, rows: [row], column_verification: [direct, null, null] });
  assert.equal(invalidColumns.success, false);
  assert.match(invalidColumns.error.message, /exactly 2 entries/);
  for (const invalid of [
    { ...direct, index: -1 }, { ...direct, index: 0.5 }, { ...direct, index: Infinity },
    { ...direct, selector: "text:" }, { ...direct, selector: "text:  " },
    { ...direct, selector: "text:alpha_z\ncoefficients:" }, { ...direct, selector: "text:alpha_z\r" },
    { ...direct, operation: "mean" }, { ...direct, operation: "range" },
    { ...direct, selector: "/coefficient" }, { ...direct, selector: "energy" },
    { ...direct, decimals: 101 }, { ...direct, expression: "coefficient * 2" },
  ]) assert.equal(ColumnVerificationSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  assert.deepEqual(ColumnVerificationSchema.parse({ selector: "text:scalar:", operation: "direct" }),
    { selector: "text:scalar:", operation: "direct" });
});

test("typed table metadata verifies actual CSV columns and JSON ranges, not fabricated values", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "source/energy.csv"), "method,energy\nA,1\nA,3\nB,999\n");
  writeFileSync(join(dir, "source/energy.json"), '{"runs":[{"energy":1},{"energy":3}]}');
  const plans = ["csv", "json"].map((extension) => ({
    ...table, table_id: `tab_${extension}`, columns: ["Energy range (J)", "Energy mean +/- std (J)"],
    rows: [{ label: "A", values: ["1.00 to 3.00", "2.00 +/- 1.41"], source_paths: [`source/energy.${extension}`] }],
    source_paths: [`source/energy.${extension}`],
    column_verification: [
      { selector: extension === "csv" ? "energy" : "/runs/*/energy", operation: "range", decimals: 2 },
      { selector: extension === "csv" ? "energy" : "/runs/*/energy", operation: "mean_std", decimals: 2, ddof: 1 },
    ],
  }));
  const outline = OutlineSchema.parse({ table_plan: plans });
  writeFileSync(join(dir, ".brain/raw/outline_v1.json"), JSON.stringify(outline));
  assert.equal(publishTables(dir), 2);
  for (const plan of plans) {
    const manifest = JSON.parse(readFileSync(join(dir, `.brain/manuscript/tables/${plan.table_id}.json`), "utf8"));
    assert.deepEqual(manifest.numeric_verification[0].expected, [1, 3]);
    assert.equal(manifest.numeric_verification[1].operation, "mean_std");
    assert.match(readFileSync(join(dir, `.brain/manuscript/tables/${plan.table_id}.tex`), "utf8"), /A & 1\.00 to 3\.00 & 2\.00 \+\/- 1\.41/);
  }
  outline.table_plan[0].rows[0].values[0] = "1.00 to 999.00";
  writeFileSync(join(dir, ".brain/raw/outline_v1.json"), JSON.stringify(outline));
  assert.throws(() => publishTables(dir), /does not match range/);
});

test("review schema matches the controller contract and rejects malformed reviews", () => {
  const review = { version: 1, manuscript_sha256: "a".repeat(64), pdf_sha256: "b".repeat(64), ready: false,
    summary: "Needs revision", findings: [{ severity: "blocking", location: "Table 1", problem: "Missing unit", action: "Add unit" }], reviewed_pages: 8 };
  assert.deepEqual(ManuscriptReviewSchema.parse(review), review);
  assert.equal(ManuscriptReviewSchema.safeParse({ ...review, pdf_sha256: "stale" }).success, false);
  assert.equal(ManuscriptReviewSchema.safeParse({ ...review, reviewed_pages: -1 }).success, false);
  assert.equal(ManuscriptReviewSchema.safeParse({ ...review, findings: [{ ...review.findings[0], severity: "minor" }] }).success, false);
});

test("brief reaches template selection and exact brief editions do not silently fall back", async (t) => {
  const dir = fixture(t);
  const brief = "Target ICLR 2025; eight pages; discuss limitations.";
  const prompt = buildTemplateSelectionPrompt({ rawMaterials: join(dir, "source"), model: null, brief });
  assert.match(prompt, /<brief>\nTarget ICLR 2025/);
  assert.match(prompt, /iclr2025/);
  assert.match(prompt, /inherited finished manuscript/);
  let decisions = 0;
  const options = { requested: "auto", rawMaterials: join(dir, "source"), model: null, brief,
    networkPolicy: "offline", cacheDirectory: join(dir, "cache"),
    decide: async (request) => { decisions++; assert.equal(request.brief, brief); return { templateId: "iclr2025", rationale: "The brief specifies this exact edition." }; },
    installOfficial: async () => { throw new Error("must not download in this test"); } };
  const selected = await resolveTemplateSelection(options);
  assert.equal(selected.templateId, "iclr2025");
  assert.equal(decisions, 1);
  const explicit = await resolveTemplateSelection({ ...options, requested: "cvpr2025" });
  assert.equal(explicit.templateId, "cvpr2025");
  assert.equal(decisions, 1);
  await assert.rejects(resolveTemplateSelection({ ...options,
    decide: async () => ({ templateId: "iclr2026", rationale: "Required exact edition." }) }), /offline/);
  await assert.rejects(resolveTemplateSelection({ ...options, requested: "cvpr2026" }), /offline/);
});

test("all stage prompts use real artifact contracts and preserve per-figure reply format", (t) => {
  const dir = fixture(t);
  for (const path of [".brain/input-manifest.json", ".brain/raw/materials.json", ".brain/raw/plotting_results.json", ".brain/manuscript/final_paper.tex", ".brain/manuscript/review.json"]) {
    writeFileSync(join(dir, path), "test artifact");
  }
  const extra = { materials: "source/results.json", paper_count: "3", min_cite_paper_count: "2",
    bibliography_origin: "Controller-supplied records.", figure_id: "fig_main", title: "Accuracy",
    objective: "Show recorded accuracy", aspect_ratio: "16:9", data_source: "source/results.json",
    data_files: "source/results.json -> data/source/results.json" };
  for (const stage of STAGES) {
    const prompt = buildStagePrompt(dir, stage, ScopeSchema.parse(baseScope), extra);
    assert.match(prompt, /source\//);
    assert.match(prompt, /\.brain\/input-manifest\.json/);
    assert.doesNotMatch(prompt, /reviewer_feedback|worklog\.json|Never explicitly state a limitation/);
    assert.doesNotMatch(prompt, /\{(?:cutoff_date|paper_count|bibliography_mode|figure_id|materials)\}/);
    if (stage === "plotting") {
      assert.match(prompt, /Caption:/);
      assert.match(prompt, /IN YOUR REPLY/);
      assert.match(prompt, /source\/results\.json -> data\/source\/results\.json/);
      assert.match(prompt, /Python standard-library readers/);
      assert.doesNotMatch(prompt, /Embed the data as|read nothing and fetch nothing|Do not read any external file/);
      assert.doesNotMatch(prompt, /Write exactly these paths/);
    } else {
      assert.match(prompt, /Write exactly these paths/);
      assert.match(prompt, /Bibliography mode: seed/);
    }
  }
  const refinement = buildStagePrompt(dir, "refinement", ScopeSchema.parse(baseScope));
  const readList = refinement.split("Read only these paths:")[1].split("Write exactly these paths:")[0];
  assert.match(readList, /\.brain\/manuscript\/review\.json/);
  assert.match(readList, /final_paper\.tex/);
  assert.match(readList, /raw_draft\.tex/);
  assert.match(readList, /manuscript\/tables/);
  assert.match(readList, /plotting_results\.json/);
  assert.match(buildStagePrompt(dir, "section_writing", ScopeSchema.parse(baseScope)), /plotting_results\.json/);
  const disabled = buildStagePrompt(dir, "outline", ScopeSchema.parse({ ...baseScope, use_plotting: false, bibliography_mode: "closed" }));
  assert.match(disabled, /disabled; use supplied figures only/);
  assert.match(disabled, /Bibliography mode: closed/);
  assert.match(disabled, /column_verification/);
  assert.match(disabled, /small, well-grounded table/);
  assert.match(disabled, /range.*minimum and maximum/);
  for (const stage of ["outline", "literature"]) {
    const prompt = buildStagePrompt(dir, stage, ScopeSchema.parse(baseScope), extra);
    assert.match(prompt, /row.cell_verification/);
    assert.match(prompt, /text:alpha_z coefficients:/);
    assert.match(prompt, /"index":2/);
    assert.match(prompt, /zero-based numeric token AFTER/);
    assert.match(prompt, /0 to 100/);
    assert.match(prompt, /not a generalized formal proof/);
    assert.match(prompt, /drop required research outcomes/);
  }
  const noMapping = buildStagePrompt(dir, "plotting", ScopeSchema.parse(baseScope), { ...extra, data_files: "" });
  assert.match(noMapping, /No runtime mapping supplied/);
});

test("prompts require anonymous review output, honest declarations and research-only prose", (t) => {
  const dir = fixture(t);
  const template = "\\documentclass{article}\n\\author{Sample Author}\n\\begin{document}\nFunding: to be completed by authors.\n\\end{document}\n";
  writeFileSync(join(dir, "template/template.tex"), template);
  const scope = ScopeSchema.parse({ ...baseScope, venue: "nature-portfolio", template_selection: "automatic" });
  for (const brief of [null, "Required sections: Methods, Results, Research provenance. State that no new simulations were performed.\n"]) {
    if (brief === null) rmSync(join(dir, "source/BRIEF.md"));
    else writeFileSync(join(dir, "source/BRIEF.md"), brief);
    for (const stage of STAGES.filter((stage) => stage !== "plotting")) {
      const prompt = buildStagePrompt(dir, stage, scope);
      assert.match(prompt, /When author metadata is absent, produce an anonymous review manuscript/);
      assert.match(prompt, /In generated TeX only/);
      assert.match(prompt, /Omit unsupported optional personal declarations/);
      assert.match(prompt, /Absence of information does not establish 'no funding', 'no conflicts' or 'not applicable'/);
      assert.match(prompt, /Never invent funding, ethics approval, consent, author contributions or conflicts of interest/);
      assert.match(prompt, /flag an actual blocker rather than inventing it/);
      assert.match(prompt, /Keep sections required by the brief and applicable venue rules/);
      assert.match(prompt, /not TODOs, sample boilerplate or promises/);
      assert.match(prompt, /Scientific prose and captions must discuss the research, not PaperOrchestra, scaffolds, workspaces/);
      assert.match(prompt, /Keep that operational rationale outside the manuscript/);
      assert.match(prompt, /no new simulations were performed, state that accurately/);
      assert.match(prompt, /source\/.*template\/.*read-only/s);
      if (brief !== null) assert.match(prompt, /source\/BRIEF\.md/);
    }
    // Prompt construction cannot "fix" a locked template or rewrite the author's brief.
    assert.equal(readFileSync(join(dir, "template/template.tex"), "utf8"), template);
    if (brief !== null) assert.equal(readFileSync(join(dir, "source/BRIEF.md"), "utf8"), brief);
  }
  const plotting = buildStagePrompt(dir, "plotting", scope);
  assert.match(plotting, /Describe the research evidence, not PaperOrchestra, scaffolds, workspaces/);
  assert.match(plotting, /Preserve explicitly required research provenance/);
  assert.match(plotting, /Caption:/);
});

test("citation gap resolutions are optional structured audits, not budget-success labels", () => {
  assert.equal(OutlineSchema.parse({}).citation_gap_resolutions, undefined);
  const citation_gap_resolutions = [
    { query: "adaptive integration reference", resolution: "cited",
      detail: "Methods, paragraph 2: cite Solver2020 for adaptive step-size control." },
    { query: "published identical original formula", resolution: "claim_narrowed",
      detail: "Methods, paragraph 3: replaced the published-equivalence claim with 'The supplied implementation tests this formula on the recorded cases.' No identical published result is asserted." },
  ];
  const outline = OutlineSchema.parse({ citation_target: 5, citation_gaps: [], citation_gap_resolutions });
  assert.deepEqual(outline.citation_gap_resolutions, citation_gap_resolutions);
  assert.equal(outline.citation_target, 5);
  for (const invalid of [
    { ...citation_gap_resolutions[0], resolution: "budget_exhausted" },
    { ...citation_gap_resolutions[0], resolution: "unanswerable" },
    { ...citation_gap_resolutions[0], query: "" },
    { ...citation_gap_resolutions[1], detail: "   " },
    { query: "unresolved external comparison", resolution: "claim_narrowed" },
  ]) assert.equal(OutlineSchema.safeParse({ citation_gap_resolutions: [invalid] }).success, false);
});

test("outline and literature gaps concern asserted external claims without relaxing five required citations", (t) => {
  const dir = fixture(t);
  const brief = "Require five relevant citations and Methods and Results sections. Report the supplied original results; no new experiments.\n";
  writeFileSync(join(dir, "source/BRIEF.md"), brief);
  const scope = ScopeSchema.parse({ ...baseScope, target_citations: 5 });
  const extra = { paper_count: "22", min_cite_paper_count: "5", bibliography_origin: "Collected records." };
  for (const stage of ["outline", "literature"]) {
    const prompt = buildStagePrompt(dir, stage, scope, extra);
    assert.match(prompt, /only for unmet support for external prior-work claims actually\nasserted/);
    assert.match(prompt, /not a list of\noriginal contributions, missing new experiments or unanswerable research questions/);
    assert.match(prompt, /Do not demand an independently published identical formula or a universal correctness\nproof/);
    assert.match(prompt, /a supplied tested result when the materials record those tests/);
    assert.match(prompt, /directly supporting citation or by narrowing\/removing/);
    assert.match(prompt, /must not remove requested research\noutcomes, required sections or the minimum citation target/);
    assert.match(prompt, /citation_gap_resolutions/);
    assert.match(prompt, /concrete revised claim/);
    assert.match(prompt, /section\/paragraph location/);
    assert.match(prompt, /Budget exhaustion is not success and does not resolve a gap/);
    assert.match(prompt, /Explicit CLI citation target: 5/);
  }
  const literature = buildStagePrompt(dir, "literature", scope, extra);
  assert.match(literature, /coverage is 5 distinct sources/);
  assert.match(literature, /Apply every revision\nto `\.brain\/raw\/updated_template\.tex`/);
  assert.match(literature, /Preserve existing audit entries/);
  assert.match(literature, /retain the unmet requirement and report\nthe actual blocker/);
  assert.equal(readFileSync(join(dir, "source/BRIEF.md"), "utf8"), brief);
});

test("CLI exposes plotting opt-out and optional adaptive citation target", () => {
  const help = execFileSync(process.execPath, [join(root, "dist/cli.js"), "write", "--help"], { encoding: "utf8" });
  assert.match(help, /--no-plotting/);
  assert.match(help, /--use-plotting/);
  assert.match(help, /--bibliography-mode/);
  assert.match(help, /adaptive citation target/);
  assert.doesNotMatch(help, /default: "20"/);
  for (const args of [["--target-citations", "NaN"], ["--target-citations", "-1"], ["--max-lkm-calls", "1.5"]]) {
    const result = spawnSync(process.execPath, [join(root, "dist/cli.js"), "write", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a nonnegative integer/);
  }
});
