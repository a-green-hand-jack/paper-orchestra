import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { preflightRun } from "../dist/preflight.js";
import { listOpencodeProviders, runDoctor } from "../dist/doctor.js";
import { UserFacingError } from "../dist/errors.js";
import { STAGES } from "../dist/stages.js";
import { OutlineSchema } from "../dist/artifacts.js";
import { planQueries } from "../dist/queries.js";

function fixture(t, plan = ["literature"]) {
  const workspace = mkdtempSync("/tmp/opencode/po-preflight-");
  for (const dir of ["bin", "source", ".brain/raw", ".po-run"]) mkdirSync(join(workspace, dir), { recursive: true });
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(workspace, { recursive: true, force: true });
  });
  process.env.PATH = join(workspace, "bin");
  delete process.env.PAPER_ORCHESTRA_IMAGE_ADAPTER;
  process.env.PROBE_LOG = join(workspace, "probes.jsonl");
  process.env.PROBE_FAIL = "";
  const tool = (name, mode = 0o755) => {
    const path = join(workspace, "bin", name);
    writeFileSync(path, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.PROBE_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'which') {
  const path = join(process.env.PATH, args[0]);
  if (!existsSync(path)) process.exit(1);
  console.log(path); process.exit(0);
}
if (process.env.PROBE_FAIL === name) { console.error('private output must not escape'); process.exit(1); }
if (name === 'opencode' && args[0] === 'auth') console.log('\\u25cf MockProvider oauth');
else if (name === 'codex') console.log(args[0] === 'login' ? 'Logged in using ChatGPT' : 'image_generation stable true');
else console.log('mock capability');
`);
    chmodSync(path, mode);
    return path;
  };
  tool("opencode"); tool("git");
  const state = {
    scope: { plan, use_plotting: false, bibliography_mode: "seed", network_policy: "online", max_lkm_calls: 4 },
    stages: Object.fromEntries(STAGES.map((id) => [id, { status: "pending" }])),
  };
  const json = (path, value) => writeFileSync(join(workspace, path), JSON.stringify(value));
  const probes = () => {
    try { return readFileSync(process.env.PROBE_LOG, "utf8").trim().split("\n").map(JSON.parse); }
    catch { return []; }
  };
  return { workspace, state, tool, json, probes };
}

test("seed literature requires invocation consent even with supplied references", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "source/references.bib"), "@article{a,title={A}}\n");
  await assert.rejects(preflightRun(f.workspace, f.state, false), (e) => e instanceof UserFacingError && /allow-lkm-spend/.test(e.message));
  assert.deepEqual(f.probes(), []);
  delete f.state.scope.bibliography_mode;
  await assert.rejects(preflightRun(f.workspace, f.state, false), /allow-lkm-spend/);
});

test("closed supplied bibliography needs neither network, budget nor bohr", async (t) => {
  const f = fixture(t);
  Object.assign(f.state.scope, { bibliography_mode: "closed", network_policy: "offline", max_lkm_calls: 0 });
  writeFileSync(join(f.workspace, "source/references.bib"), "@article{a,title={A}}\n");
  await preflightRun(f.workspace, f.state, false);
  assert.deepEqual(f.probes(), []);
});

test("closed without a supplied bibliography fails without permitting retrieval", async (t) => {
  const f = fixture(t);
  f.state.scope.bibliography_mode = "closed";
  await assert.rejects(preflightRun(f.workspace, f.state, false), /author-supplied/);
  await assert.rejects(preflightRun(f.workspace, f.state, true), /no retrieval is permitted/);
  assert.deepEqual(f.probes(), []);
});

test("offline and zero budget fail before authentication", async (t) => {
  const f = fixture(t);
  f.state.scope.network_policy = "offline";
  await assert.rejects(preflightRun(f.workspace, f.state, true), /offline/);
  f.state.scope.network_policy = "online";
  f.state.scope.max_lkm_calls = 0;
  await assert.rejects(preflightRun(f.workspace, f.state, true), /positive/);
  assert.deepEqual(f.probes(), []);
});

test("bohr must be executable and authentication uses only a non-billable identity check", async (t) => {
  const f = fixture(t);
  await assert.rejects(preflightRun(f.workspace, f.state, true), /bohr/);
  f.tool("bohr", 0o644);
  await assert.rejects(preflightRun(f.workspace, f.state, true), /bohr/);
  f.tool("bohr");
  process.env.PROBE_FAIL = "bohr";
  await assert.rejects(preflightRun(f.workspace, f.state, true), (e) => /authentication/.test(e.message) && !/private output/.test(e.message));
  process.env.PROBE_FAIL = "";
  await preflightRun(f.workspace, f.state, true);
  assert.deepEqual(f.probes(), [["bohr", "auth", "whoami"], ["bohr", "auth", "whoami"]]);
});

test("resume does not impose tools or spend for completed or unplanned stages", async (t) => {
  const f = fixture(t, ["literature", "outline"]);
  f.state.stages.literature.status = "completed";
  f.state.scope.network_policy = "offline";
  f.json(".po-run/literature-cache.json", { callsMade: 2, candidates: [], completedQueries: ["done"] });
  await preflightRun(f.workspace, f.state, false);
  f.state.stages.outline.status = "completed";
  process.env.PATH = "";
  await preflightRun(f.workspace, f.state, false);
});

test("manuscript and refinement tool requirements follow unfinished stages", async (t) => {
  const f = fixture(t, ["section_writing", "refinement"]);
  for (const binary of ["pdflatex", "bibtex", "pdftotext", "pdftoppm", "pdfinfo"]) {
    await assert.rejects(preflightRun(f.workspace, f.state, false), new RegExp(binary));
    f.tool(binary);
  }
  await preflightRun(f.workspace, f.state, false);
});

test("usable resume cache waives new spend, but partial or malformed cache does not", async (t) => {
  const f = fixture(t);
  const outline = OutlineSchema.parse({ section_plan: [{ section_title: "Method", subsections: [
    { subsection_title: "Optimizer", citation_hints: ["Adam: A Method for Stochastic Optimization"] },
  ] }] });
  f.json(".brain/raw/outline.json", outline);
  const completedQueries = planQueries(outline).queries;
  assert.ok(completedQueries.length > 0);
  const cache = { callsMade: 1, completedQueries, cache: {}, candidates: [{ citation_key: "adam", title: "Adam",
    provider: "bohrium_lkm", provider_id: "paper-1", retrieved_at: "2026-09-05" }] };
  f.json(".po-run/literature-cache.json", cache);
  f.state.scope.network_policy = "offline";
  await preflightRun(f.workspace, f.state, false);
  f.json(".po-run/literature-cache.json", { ...cache, completedQueries: [] });
  await assert.rejects(preflightRun(f.workspace, f.state, false), /offline/);
  f.json(".po-run/literature-cache.json", { ...cache, candidates: [{}] });
  await assert.rejects(preflightRun(f.workspace, f.state, false), /offline/);
  f.json(".po-run/literature-cache.json", { ...cache, callsMade: 4, completedQueries: [] });
  await preflightRun(f.workspace, f.state, false);
  // The initial phase reserves one of four calls for later gap retrieval.
  f.json(".po-run/literature-cache.json", { ...cache, callsMade: 3, initialCallsMade: 3, completedQueries: [] });
  await preflightRun(f.workspace, f.state, false);
  for (const changes of [
    { cache: null },
    { callsMade: 4, initialCallsMade: 5 },
    { callsMade: 4, failures: [{ query: completedQueries[0], message: "retry required" }] },
  ]) {
    f.json(".po-run/literature-cache.json", { ...cache, ...changes });
    await assert.rejects(preflightRun(f.workspace, f.state, false), /offline/);
  }
  f.json(".po-run/literature-cache.json", { ...cache, completedQueries: completedQueries.map((q) => `  ${q.toUpperCase()}  `) });
  await preflightRun(f.workspace, f.state, false);
  f.json(".po-run/literature-cache.json", { ...cache, completedQueries: [], cache: Object.fromEntries(
    completedQueries.map((q) => [JSON.stringify([q.trim().toLowerCase().replace(/\s+/g, " "), 10, "abstract,conclusion"]),
      { papers: [], retrievedAt: "2026-09-05" }]),
  ) });
  await preflightRun(f.workspace, f.state, false);
  assert.deepEqual(f.probes(), []);
});

test("code-only figures do not probe image providers", async (t) => {
  const f = fixture(t, ["plotting"]);
  f.state.scope.use_plotting = true;
  f.json(".brain/raw/outline.json", { plotting_plan: [{ figure_id: "chart", plot_type: "diagram", render_route: "code" }] });
  f.tool("python3"); f.tool("pdftoppm");
  await preflightRun(f.workspace, f.state, false);
  assert.equal(f.probes().length, 1);
  assert.equal(f.probes()[0][0], "python3");
  process.env.PROBE_FAIL = "python3";
  await assert.rejects(preflightRun(f.workspace, f.state, false), /matplotlib/);
});

test("image routes validate selected adapter without executing it or requiring Python", async (t) => {
  const f = fixture(t, ["plotting"]);
  f.state.scope.use_plotting = true;
  f.json(".brain/raw/outline.json", { plotting_plan: [{ figure_id: "architecture", plot_type: "diagram" }] });
  process.env.PAPER_ORCHESTRA_IMAGE_ADAPTER = f.tool("adapter", 0o644);
  await assert.rejects(preflightRun(f.workspace, f.state, false), /absolute executable path/);
  f.tool("adapter");
  await preflightRun(f.workspace, f.state, false);
  process.env.PAPER_ORCHESTRA_IMAGE_ADAPTER = "adapter";
  await preflightRun(f.workspace, f.state, false);
  process.env.PAPER_ORCHESTRA_IMAGE_ADAPTER = "./bin/adapter";
  await assert.rejects(preflightRun(f.workspace, f.state, false), /absolute/);
  assert.deepEqual(f.probes(), []);
});

test("before an outline only an actual diagram brief requires image capability", async (t) => {
  const f = fixture(t, ["outline", "plotting"]);
  f.state.scope.use_plotting = true;
  f.tool("python3"); f.tool("pdftoppm");
  const brief = join(f.workspace, "source/BRIEF.md");
  writeFileSync(brief, "Generate code plots. Do not generate a diagram.");
  await preflightRun(f.workspace, f.state, false);
  writeFileSync(brief, "Generate an architecture diagram.");
  await assert.rejects(preflightRun(f.workspace, f.state, false), /Codex/);
  f.tool("codex");
  await preflightRun(f.workspace, f.state, false);
  assert.ok(f.probes().some((p) => p.join(" ") === "codex login status"));
  assert.ok(f.probes().every((p) => !p.includes("exec")));
});

test("doctor uses safe provider listing and reports missing bohr and visual capability honestly", async (t) => {
  const f = fixture(t, []);
  f.tool("which");
  assert.deepEqual(await listOpencodeProviders(), ["MockProvider"]);
  const result = await runDoctor();
  assert.equal(result.checks.find((c) => c.name === "pdfinfo").advisory, false);
  assert.equal(result.checks.find((c) => c.name === "pdfinfo").passed, false);
  assert.ok(f.probes().some((p) => p.join(" ") === "which pdfinfo"));
  f.tool("pdfinfo");
  assert.equal((await runDoctor()).checks.find((c) => c.name === "pdfinfo").passed, true);
  assert.equal(result.probes.find((p) => p.name.startsWith("bohr")).satisfied, false);
  assert.ok(!result.probes.find((p) => p.name.startsWith("pdftoppm")).detail.includes("skip visual review"));
  assert.ok(f.probes().every((p) => !p.includes("show")));
});
