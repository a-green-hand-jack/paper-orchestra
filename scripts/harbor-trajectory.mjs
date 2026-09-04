#!/usr/bin/env node
/**
 * Assert that a PaperOrchestra run behaved as designed, not merely that its
 * output scored.
 *
 * The binary reward answers "is the artifact acceptable". It cannot see that a
 * stage burned its whole remediation budget, that the relevance gate admitted
 * cross-domain noise, or that a figure the author supplied never made it into
 * the manuscript. Those are properties of the trajectory, and the run records
 * all of them on disk -- so this check costs nothing and needs no model.
 *
 * Usage: node scripts/harbor-trajectory.mjs <workspace>
 * Exits 0 when every assertion holds, 1 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const LKM_CALL_PRICE_CNY = 0.05;

const workspace = process.argv[2];
if (!workspace) {
  process.stderr.write("usage: harbor-trajectory.mjs <workspace>\n");
  process.exit(1);
}

function readJson(rel) {
  const path = join(workspace, rel);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
}
function note(name, detail) {
  results.push({ name, passed: null, detail });
}

const state = readJson(join(".po-run", "run.json"));
if (!state) {
  process.stderr.write(`harbor-trajectory: no .po-run/run.json under ${workspace}\n`);
  process.exit(1);
}

// --- Stage outcomes -------------------------------------------------------
const plan = state.scope?.plan ?? [];
const stages = state.stages ?? {};
const notCompleted = plan.filter((s) => stages[s]?.status !== "completed");
check(
  "every planned stage completed",
  notCompleted.length === 0,
  notCompleted.length
    ? notCompleted.map((s) => `${s}=${stages[s]?.status ?? "missing"}`).join(", ")
    : `${plan.length} stage(s): ${plan.join(", ")}`,
);
check("run status is completed", state.status === "completed", `status=${state.status}`);

const retried = plan.filter((s) => (stages[s]?.attempts ?? 0) > 1);
check(
  "no stage was entered more than once",
  retried.length === 0,
  retried.length ? retried.map((s) => `${s}=${stages[s].attempts}`).join(", ") : "all attempts=1",
);

// A remediation is not a failure, but a stage that spent its whole budget is a
// finding that needs an explanation rather than a silent pass.
//
// Transcribed from `REMEDIATION_ATTEMPTS` rather than imported. That is
// deliberate -- a grader that shares code with the thing it grades cannot
// detect a change in it -- but transcription drifts: adding the `triage` stage
// left this table one entry short, and a `?? 1` fallback would have hidden that
// behind a number that happened to be right. So an unknown stage is a hard
// error here, which turns silent drift into a message naming the stage.
const BUDGET = {
  triage: 1,
  outline: 1,
  literature: 1,
  plotting: 2,
  section_writing: 2,
  refinement: 2,
};
const unknown = plan.filter((s) => !(s in BUDGET));
if (unknown.length > 0) {
  console.error(
    `harbor-trajectory does not know the remediation budget for: ${unknown.join(", ")}. ` +
      "Update BUDGET from REMEDIATION_ATTEMPTS in src/stages.ts before reporting a result.",
  );
  process.exit(2);
}
const exhausted = plan.filter((s) => (stages[s]?.remediations ?? 0) >= BUDGET[s]);
const anyRemediation = plan.filter((s) => (stages[s]?.remediations ?? 0) > 0);
check(
  "no stage exhausted its remediation budget",
  exhausted.length === 0,
  anyRemediation.length
    ? anyRemediation.map((s) => `${s}=${stages[s].remediations}/${BUDGET[s]}`).join(", ")
    : "no remediation was needed",
);

// --- Spend ----------------------------------------------------------------
const queryPlan = readJson(join(".brain", "raw", "query_plan.json"));
const candidates = readJson(join(".brain", "raw", "candidates.json"));
const citationMap = readJson(join(".brain", "raw", "citation_map.json"));
const maxCalls = state.scope?.max_lkm_calls ?? null;
if (queryPlan) {
  // `action` is one of kept | contextualized | dropped; only a dropped query
  // costs nothing, so the paid count is everything else.
  const decisions = queryPlan.decisions ?? [];
  const paid = decisions.filter((d) => d.action !== "dropped").length;
  const dropped = decisions.filter((d) => d.action === "dropped").length;
  check(
    "retrieval stayed inside its call ceiling",
    maxCalls === null || paid <= maxCalls,
    `${paid} paid of ${decisions.length} candidate quer(ies), ${dropped} dropped before paying, ` +
      `ceiling ${maxCalls} ~= ${(paid * LKM_CALL_PRICE_CNY).toFixed(2)} CNY`,
  );
} else {
  note("query plan", "no query_plan.json to audit");
}

// --- The relevance gate cannot be audited from disk (issue #19) -----------
// `relevance.ts` is load-bearing: LKM indexes all of science, and real runs
// admitted agriculture and gastroenterology papers. But its rejected set and
// drop counts are only ever printed (`controller.ts:549-551`), never written,
// so there is no artifact to assert against -- `candidates.json` is already
// the POST-gate set, which is why comparing it with `citation_map.json`
// measures nothing. Report what is knowable and name the gap rather than
// asserting something that cannot fail.
if (Array.isArray(candidates) && citationMap) {
  const admitted = Object.keys(citationMap).length;
  check(
    "every admitted candidate reached the citation map",
    candidates.length === admitted,
    `${candidates.length} candidate(s), ${admitted} keyed`,
  );
  note(
    "relevance gate outcome",
    "not auditable from disk; the rejected set is print-only (issue #19)",
  );
} else {
  note("relevance gate", "candidates.json or citation_map.json missing");
}

// --- Figures --------------------------------------------------------------
const info = readJson(join(".brain", "manuscript", "figures", "info.json"));
const finalTex = join(workspace, ".brain", "manuscript", "final_paper.tex");
if (Array.isArray(info) && existsSync(finalTex)) {
  const tex = readFileSync(finalTex, "utf8");
  const included = [
    ...tex.matchAll(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g),
  ].map((m) => m[1].trim());
  const unused = info.filter(
    (f) => !included.some((p) => p === f.name || p.endsWith(`/${f.name}`) ||
      p.replace(/\.[^.]+$/, "").endsWith(f.name.replace(/\.[^.]+$/, ""))),
  );
  check(
    "every supplied figure is used by the manuscript",
    unused.length === 0,
    unused.length ? `unused: ${unused.map((f) => f.name).join(", ")}` : `${info.length} figure(s) all included`,
  );

  // Reported, not asserted: 4-po-section-writing.md:58 explicitly permits "You
  // can refine the captions if necessary", so a rewrite is not a violation.
  // It is still worth surfacing, because the same prompt claims at :52 that the
  // model is "provided with the actual image files" while section_writing
  // attaches none -- so any rewrite of a caption describing visual layout was
  // written without seeing the layout.
  const reused = info.filter((f) => {
    const head = (f.caption ?? "").replace(/^Figure\s*\d+\.\s*/i, "").slice(0, 40).trim();
    return head.length > 0 && tex.includes(head);
  });
  note(
    "supplied captions",
    `${reused.length}/${info.length} kept verbatim; rewriting is permitted by the prompt, ` +
      `but the model cannot see the images it is told to describe`,
  );
} else {
  note("figures", "info.json or final_paper.tex missing");
}

// --- Anonymity, as a reviewer would see it --------------------------------
const pdf = join(workspace, ".brain", "manuscript", "final_paper.pdf");
if (existsSync(pdf)) {
  const run = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8", timeout: 60_000 });
  const text = run.stdout ?? "";
  const leaked = ["Ambitious AI Researcher", "123 AI Avenue", "researcher@institute.ai"].filter(
    (needle) => text.includes(needle),
  );
  check(
    "the rendered PDF carries no fabricated author identity",
    leaked.length === 0,
    leaked.length ? `leaked: ${leaked.join(", ")}` : "none of the known placeholder identities appear",
  );
  check(
    "the rendered PDF is anonymized",
    /anonymous/i.test(text),
    /anonymous/i.test(text) ? "contains 'Anonymous'" : "no 'Anonymous' marker on the title page",
  );
} else {
  note("rendered PDF", "final_paper.pdf missing");
}

// --- Checkpoint provenance ------------------------------------------------
const git = spawnSync("git", ["-C", workspace, "log", "--format=%s%n%b", "--all"], {
  encoding: "utf8",
});
if (git.status === 0) {
  const log = git.stdout ?? "";
  const missingTrailer = plan.filter((s) => !new RegExp(`PO-Stage:\\s*${s}\\b`).test(log));
  check(
    "each stage left a checkpoint recording its validation",
    missingTrailer.length === 0,
    missingTrailer.length ? `no PO-Stage trailer for: ${missingTrailer.join(", ")}` :
      `${plan.length} stage trailer(s) present`,
  );
} else {
  note("checkpoints", "workspace is not a git repository");
}

// --- Report ---------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
for (const r of results) {
  const mark = r.passed === null ? "note" : r.passed ? "ok  " : "FAIL";
  if (r.passed === false) failed += 1;
  process.stdout.write(`${mark}  ${r.name.padEnd(width)}  ${r.detail}\n`);
}
process.stdout.write(
  `\n${results.filter((r) => r.passed === true).length} passed, ${failed} failed, ` +
    `${results.filter((r) => r.passed === null).length} not applicable\n`,
);
process.exit(failed === 0 ? 0 : 1);
