import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ARTIFACTS } from "../dist/paths.js";
import { digestFile } from "../dist/files.js";
import { reviewManuscript, manuscriptReadiness } from "../dist/manuscript-review.js";
import { publishTables, tableCoverage, tablePlanCheck, exportSubmission } from "../dist/presentation.js";
import { compileLatex, stageBuildDir } from "../dist/latexbuild.js";

function put(dir, rel, value) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
}
function fixture(t) {
  const dir = mkdtempSync("/tmp/opencode/po-review-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of ["source", ".brain/input", ".brain/raw", ".brain/manuscript", ".brain/tmp/build", "template"]) mkdirSync(join(dir, rel), { recursive: true });
  put(dir, "source/BRIEF.md", "Report measured results and limitations.");
  put(dir, ".brain/input/results.json", { score: 81.2 });
  put(dir, ARTIFACTS.outlineV1, { table_plan: [] });
  return dir;
}
const table = { table_id: "main", title: "Measured results", caption: "A & B_1: 81% \\input{bad}",
  section: "Results", columns: ["Accuracy (%)", "Unavailable"],
  rows: [{ label: "A_1", values: [81.2, null], source_paths: [".brain/input/results.json"] }],
  source_paths: [".brain/input/results.json"] };

// A real, tiny PDF fixture, built locally without TeX, Python, or any model request.
function pdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = [];
  for (let i = 0; i < pages; i++) {
    kids.push(`${objects.length + 1} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 180 180] /Resources << >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push("<< /Length 0 >>\nstream\n\nendstream");
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`;
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function build(dir, pages = 1) {
  put(dir, ARTIFACTS.finalTex, "\\documentclass{article}\n\\begin{document}Measured 81.2.\\end{document}\n");
  put(dir, ARTIFACTS.finalPdf, pdf(pages));
  stageBuildDir(dir, join(dir, ARTIFACTS.finalTex));
  copyFileSync(join(dir, ARTIFACTS.finalPdf), join(dir, ".brain/tmp/build/manuscript.pdf"));
  put(dir, ARTIFACTS.buildReport, { ok: true, source: ARTIFACTS.finalTex, pdf: ARTIFACTS.finalPdf,
    pages, errors: [], built_at: new Date().toISOString() });
}
const approved = { version: 1, manuscript_sha256: "a".repeat(64), pdf_sha256: "b".repeat(64),
  ready: true, summary: "Content and layout reviewed", findings: [], reviewed_pages: 999 };
function runtime(dir, replies) {
  const calls = [];
  const creates = [];
  let busy = false;
  let reply = "";
  return { directory: dir, calls, creates, client: { session: {
    create: async (options) => { creates.push(options); return { data: { id: `review-${creates.length}` } }; },
    promptAsync: async (options) => { calls.push(options); busy = true; reply = replies.shift() ?? "notes"; return { data: true }; },
    status: async () => { const result = { data: { "review-1": { type: busy ? "busy" : "idle" } } }; busy = false; return result; },
    messages: async () => ({ data: [{ info: { role: "assistant", tokens: { input: 10, output: 5 }, cost: 0 }, parts: [{ type: "text", text: reply }] }] }),
    abort: async () => ({ data: true }),
  } } };
}
const poppler = ["pdfinfo", "pdftoppm"].every((bin) => spawnSync(bin, ["-v"]).status === 0);

test("review attaches all 13 pages, repairs JSON once, overwrites model metadata and records usage", { skip: !poppler }, async (t) => {
  const dir = fixture(t); build(dir, 13);
  const rt = runtime(dir, ["first pages", "next pages", "not json", JSON.stringify(approved)]);
  const result = await reviewManuscript({ runtime: rt, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 });
  assert.equal(result.ready, true);
  assert.equal(result.reviewed_pages, 13);
  assert.equal(result.manuscript_sha256, digestFile(join(dir, ARTIFACTS.finalTex)));
  assert.equal(result.pdf_sha256, digestFile(join(dir, ARTIFACTS.finalPdf)));
  assert.equal(rt.creates.length, 1);
  assert.deepEqual(rt.creates[0].permission, [{ permission: "*", pattern: "*", action: "deny" }]);
  assert.equal(rt.calls.length, 4);
  const images = rt.calls.flatMap((call) => call.parts.filter((part) => part.type === "file"));
  assert.equal(images.length, 13);
  assert.equal(new Set(images.map((image) => image.filename)).size, 13);
  assert.match(rt.calls[0].parts[0].text, /outline_v1.json/);
  assert.match(rt.calls[0].parts[0].text, /81.2/);
  assert.equal(manuscriptReadiness(dir).passed, true);
  const attempts = readdirSync(join(dir, ".po-run/reviews"));
  const snapshot = join(dir, ".po-run/reviews", attempts[0], "attempt.json");
  const record = JSON.parse(readFileSync(snapshot));
  assert.equal(record.usage[record.sessions[0]].input_tokens, 10);
  assert.equal(statSync(snapshot).mode & 0o222, 0);
  put(dir, ARTIFACTS.finalTex, "changed source");
  assert.equal(manuscriptReadiness(dir).passed, false);
});

test("blocking finding overrides ready; malformed review never becomes approval", { skip: !poppler }, async (t) => {
  const dir = fixture(t); build(dir);
  const rt = runtime(dir, [JSON.stringify({ ...approved, findings: [{ severity: "blocking", location: "page 1", problem: "missing evidence", action: "add evidence" }] })]);
  assert.equal((await reviewManuscript({ runtime: rt, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 })).ready, false);
  assert.match(manuscriptReadiness(dir).detail, /page 1: missing evidence Action: add evidence/);
  const broken = runtime(dir, ["bad", "still bad"]);
  await assert.rejects(reviewManuscript({ runtime: broken, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 }), /after one repair/);
  assert.equal(broken.calls.length, 2);
  assert.equal(manuscriptReadiness(dir).passed, false);
  assert.match(manuscriptReadiness(dir).detail, /after one repair/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".brain/manuscript/review.json"))).ready, false);
  assert.equal(readdirSync(join(dir, ".po-run/reviews")).length, 2);
});

test("stale PDF and writer-produced approval fail without contacting a model", async (t) => {
  const dir = fixture(t); build(dir);
  put(dir, ".brain/manuscript/review.json", { ...approved, manuscript_sha256: digestFile(join(dir, ARTIFACTS.finalTex)),
    pdf_sha256: digestFile(join(dir, ARTIFACTS.finalPdf)), reviewed_pages: 1 });
  assert.equal(manuscriptReadiness(dir).passed, false);
  put(dir, ARTIFACTS.finalPdf, pdf(2));
  const rt = runtime(dir, []);
  await assert.rejects(reviewManuscript({ runtime: rt, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 }), /Stale build/);
  assert.equal(rt.creates.length, 0);
});

test("tables escape data, are deterministic, and verify inclusion and source manifests", (t) => {
  const dir = fixture(t);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [table] });
  assert.equal(publishTables(dir), 1);
  const path = join(dir, ".brain/manuscript/tables/main.tex");
  const text = readFileSync(path, "utf8");
  assert.match(text, /A \\& B\\_1/);
  assert.match(text, /\\textbackslash\{\}input\\\{bad\\\}/);
  assert.match(text, /81.2 & --/);
  assert.match(text, /\\label\{tab:main\}/);
  publishTables(dir);
  assert.equal(readFileSync(path, "utf8"), text);
  put(dir, ARTIFACTS.finalTex, "% \\input{tables/main}\nNo table.");
  assert.equal(tableCoverage(dir, ARTIFACTS.finalTex).passed, false);
  put(dir, ARTIFACTS.finalTex, "\\input{sections/results}");
  put(dir, ".brain/manuscript/sections/results.tex", "\\input{tables/main}");
  assert.equal(tableCoverage(dir, ARTIFACTS.finalTex).passed, true);
  put(dir, ".brain/input/results.json", { score: 99 });
  assert.equal(tableCoverage(dir, ARTIFACTS.finalTex).passed, false);
});

test("table provenance rejects traversal, external symlinks, and duplicate ids", (t) => {
  const dir = fixture(t);
  for (const source of [".brain/input/../../raw/results.json", "/etc/passwd", "template/results.json"]) {
    put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, source_paths: [source] }] });
    assert.throws(() => publishTables(dir));
  }
  symlinkSync(join(dir, "source/BRIEF.md"), join(dir, ".brain/input/link.json"));
  put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, source_paths: [".brain/input/link.json"] }] });
  assert.throws(() => publishTables(dir));
  put(dir, ARTIFACTS.outlineV1, { table_plan: [table, table] });
  assert.throws(() => publishTables(dir), /Duplicate/);
});

test("submission preserves nested manuscript and venue dependencies, adapts bibliography, excludes research inputs", (t) => {
  const dir = fixture(t); build(dir);
  put(dir, ARTIFACTS.finalTex, "\\input{sections/results}\n\\bibliography{../raw/references}\n");
  put(dir, ".brain/manuscript/sections/results.tex", "Results");
  put(dir, "template/styles/venue.sty", "% venue style");
  put(dir, ARTIFACTS.references, "@article{measured,title={Measured}}");
  put(dir, "source/paper.pdf", pdf(1));
  put(dir, ".brain/manuscript/.env", "DO_NOT_EXPORT");
  exportSubmission(dir);
  assert.equal(readFileSync(join(dir, "submission/sections/results.tex"), "utf8"), "Results");
  assert.match(readFileSync(join(dir, "submission/main.tex"), "utf8"), /\\bibliography\{references\}/);
  assert.equal(readFileSync(join(dir, "submission/styles/venue.sty"), "utf8"), "% venue style");
  assert.equal(digestFile(join(dir, "submission/final.pdf")), digestFile(join(dir, ARTIFACTS.finalPdf)));
  assert.ok(!readdirSync(join(dir, "submission")).includes(".env"));
  assert.ok(!readdirSync(join(dir, "submission")).includes("source"));
  assert.match(readFileSync(join(dir, "submission/README.md"), "utf8"), /pdflatex -no-shell-escape/);
  const modified = statSync(join(dir, "submission/main.tex")).mtimeMs;
  exportSubmission(dir);
  assert.equal(statSync(join(dir, "submission/main.tex")).mtimeMs, modified);
  assert.equal(JSON.parse(readFileSync(join(dir, ".po-run/submission.json"))).files["main.tex"], digestFile(join(dir, "submission/main.tex")));
  put(dir, "submission/main.tex", "User edit must survive.");
  assert.throws(() => exportSubmission(dir), /refusing to overwrite/);
  assert.equal(readFileSync(join(dir, "submission/main.tex"), "utf8"), "User edit must survive.");
});

test("numeric provenance rejects invented cells, unrelated fields and ambiguous records", (t) => {
  const dir = fixture(t);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, rows: [{ ...table.rows[0], values: [81.8, null] }] }] });
  assert.throws(() => publishTables(dir), /does not match direct/);
  put(dir, ".brain/input/results.json", { accuracy: 81.2, latency: 7 });
  put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, rows: [{ ...table.rows[0], values: [7, null] }] }] });
  assert.throws(() => publishTables(dir), /does not match direct/);
  put(dir, ".brain/input/results.json", [{ method: "A_1", accuracy: 81.2 }, { method: "B", accuracy: 99 }]);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [table] });
  assert.equal(publishTables(dir), 1);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, rows: [{ ...table.rows[0], values: [99, null] }] }] });
  assert.throws(() => publishTables(dir), /does not match direct/);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [{ ...table, rows: [{ ...table.rows[0], label: "Unknown", values: [99, null] }] }] });
  assert.throws(() => publishTables(dir), /multiple source records/);
});

test("CSV min/max/mean and population/sample std are computed from actual measurements", (t) => {
  const dir = fixture(t);
  const source = ".brain/input/runs.csv";
  put(dir, source, 'run,score,note\r\n1,2,"first, quoted"\r\n2,4,"two\nlines"\r\n3,4,"quote ""here"""\r\n4,4,x\r\n5,5,x\r\n6,5,x\r\n7,7,x\r\n8,9,x\r\n');
  const spec = { ...table, columns: ["Min", "Max", "Mean", "Std"], source_paths: [source],
    rows: [{ label: "All observations", values: [2, 9, 5, 2], source_paths: [source] }],
    calculation: "Compute min/max/mean/population std rounded to 2 decimals.",
    column_verification: ["min", "max", "mean", "std"].map((operation) => ({ selector: "score", operation, decimals: 2, ddof: 0 })) };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  const manifest = JSON.parse(readFileSync(join(dir, ".brain/manuscript/tables/main.json")));
  assert.deepEqual(manifest.numeric_verification.map((entry) => entry.expected), [[2], [9], [5], [2]]);
  spec.column_verification[3].ddof = 1;
  spec.rows[0].values[3] = 2.14;
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  spec.rows[0].values[3] = 2.15;
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.throws(() => publishTables(dir), /does not match std/);
  delete spec.column_verification[3].ddof;
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.throws(() => publishTables(dir), /explicit population\/sample/);
});

test("described aggregates, rounded negative ranges and indexed JSON selectors need no guessed transforms", (t) => {
  const dir = fixture(t);
  put(dir, ".brain/input/results.json", { energy: [-308.623, -289.174, -300.222] });
  let spec = { ...table, columns: ["Range"], rows: [{ ...table.rows[0], values: ["(-308.62 to -289.17)"] }],
    calculation: "Minimum and maximum range rounded to 2 decimals." };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  spec.rows[0].values[0] = "(-308.62 to -288.17)";
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.throws(() => publishTables(dir), /does not match range/);
  put(dir, ".brain/input/results.json", { score: [2, 4, 4, 4, 5, 5, 7, 9] });
  spec = { ...table, columns: ["Min", "Max", "Mean", "Std"], rows: [{ ...table.rows[0], values: [2, 9, 5, 2] }],
    calculation: "Compute min/max/mean/population std rounded to 2 decimals." };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  spec.calculation = "Compute median and scale to percent.";
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.throws(() => publishTables(dir), /unsupported/);
  spec = { ...table, columns: ["Recorded score"], rows: [{ ...table.rows[0], values: [7] }],
    column_verification: [{ selector: "/score/6", operation: "direct" }] };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  put(dir, ".brain/input/results.json", { score: [2, 4, null] });
  spec.column_verification = [{ selector: "/score/*", operation: "mean" }];
  spec.rows[0].values = [3];
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.throws(() => publishTables(dir), /missing or nonnumeric measurements/);
});

test("heterogeneous Gewu-shaped rows verify original fitted coefficients and CSV fields without changing results", (t) => {
  const dir = fixture(t);
  const logPath = "source/kerr_axis_ks_run.txt";
  const csvPath = "source/kerr_axis_ks.csv";
  // Synthetic compact fixture in the inspected raw log/CSV format, not an inherited manuscript.
  const log = "# Fit alpha = c1/b + c2/b^2 + ...\n" +
    "alpha_y coefficients: 4.16761728218e-10 2.80000106406 10.9956796268 43.4111984293\n" +
    "alpha_z coefficients: 4.00000000154 11.780971282 40.7070301858 156.319605565\n" +
    "analytic alpha_z c1..c3: 4 11.780972451 40.7066666667\n" +
    "max |g^munu p_mu p_nu|: 1.00957e-11\n";
  const csv = "b,alpha_y,alpha_z,n_steps,null_error\n" +
    "40,0.001940733791989714,0.1080672204931976,96,1.00957020521264e-11\n" +
    "50,0.001215541850334024,0.08506529863616312,97,9.61253299180953e-12\n" +
    "60,0.0008322831281453513,0.07014056682222967,96,9.000356016031219e-12\n";
  put(dir, logPath, log); put(dir, csvPath, csv);
  const cell = (prefix, index, decimals) => ({ selector: `text:${prefix}`, operation: "direct", ...(index === undefined ? {} : { index }), ...(decimals === undefined ? {} : { decimals }) });
  const spec = { ...table, columns: ["Value", "Record"], source_paths: [logPath, csvPath],
    column_verification: [{ selector: "b", operation: "range", decimals: 2 }, null],
    rows: [
      { label: "Fitted transverse coefficient", values: [10.9956796268, "Fit"], source_paths: [logPath],
        cell_verification: [cell("alpha_y coefficients:", 2), null] },
      { label: "Fitted axial coefficient", values: [40.7070301858, "Fit"], source_paths: [logPath],
        cell_verification: [cell("alpha_z coefficients:", 2, 14), null] },
      { label: "Recorded analytic axial coefficient", values: [40.7066666667, "Analytic"], source_paths: [logPath],
        cell_verification: [cell("analytic alpha_z c1..c3:", 2, 10), null] },
      { label: "Logged constraint error", values: [1.00957e-11, "Log"], source_paths: [logPath],
        cell_verification: [cell("max |g^munu p_mu p_nu|:", undefined, 16), null] },
      { label: "Constraint error maximum", values: [1.00957020521264e-11, "CSV"], source_paths: [csvPath],
        cell_verification: [{ selector: "null_error", operation: "max", decimals: 25 }, null] },
      { label: "Impact parameter range", values: ["40.00 to 60.00", "CSV"], source_paths: [csvPath], cell_verification: [null, null] },
    ] };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(tablePlanCheck(dir).passed, true, tablePlanCheck(dir).detail);
  assert.equal(publishTables(dir), 1);
  const manifest = JSON.parse(readFileSync(join(dir, ".brain/manuscript/tables/main.json")));
  assert.deepEqual(manifest.numeric_verification.map((entry) => entry.expected),
    [[10.9956796268], [40.7070301858], [40.7066666667], [1.00957e-11], [1.00957020521264e-11], [40, 60]]);
  assert.deepEqual(manifest.numeric_verification[1].text_source, {
    path: logPath, line: 3, prefix: "alpha_z coefficients:", index: 2, token: "40.7070301858",
  });
  assert.equal(manifest.numeric_verification[0].operation, "direct"); // Override is not merged with column range/rounding.
  const tex = readFileSync(join(dir, ".brain/manuscript/tables/main.tex"), "utf8");
  assert.match(tex, /Group & Value & Record/);
  assert.match(tex, /p\{\\dimexpr/);
  assert.match(tex, /40\.7070301858/);
  put(dir, ARTIFACTS.finalTex, "\\input{tables/main}");
  assert.equal(tableCoverage(dir, ARTIFACTS.finalTex).passed, true);
  assert.equal(readFileSync(join(dir, logPath), "utf8"), log);
  assert.equal(readFileSync(join(dir, csvPath), "utf8"), csv);
  spec.column_verification.push(null); // Row overrides cannot hide the original 3-for-2 schema error.
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(tablePlanCheck(dir).passed, false);
  assert.match(tablePlanCheck(dir).detail, /exactly 2 entries/);
  assert.match(tablePlanCheck(dir).detail, /row.cell_verification/);
  assert.match(tablePlanCheck(dir).detail, /"index":2/);
  assert.throws(() => publishTables(dir), /exactly 2 entries/);
  assert.equal(readFileSync(join(dir, ".brain/manuscript/tables/main.tex"), "utf8"), tex);
});

test("log selectors reject ambiguous, non-original, missing and fabricated numeric fields", (t) => {
  const dir = fixture(t);
  const source = "source/run.log";
  const spec = { ...table, columns: ["Coefficient"], source_paths: [source],
    calculation: "Direct extraction of the recorded coefficient from the original log.",
    rows: [{ label: "Axial", values: [40.7070301858], source_paths: [source],
      cell_verification: [{ selector: "text:alpha_z coefficients:", operation: "direct", index: 2, decimals: 10 }] }] };
  const original = "alpha_z coefficients: 4.00000000154 11.780971282 40.7070301858\n";
  const check = (body, overrides = {}) => {
    put(dir, source, body);
    const plan = structuredClone(spec);
    Object.assign(plan.rows[0].cell_verification[0], overrides);
    put(dir, ARTIFACTS.outlineV1, { table_plan: [plan] });
    return tablePlanCheck(dir);
  };
  assert.equal(check(original).passed, true);
  for (const [body, overrides, message] of [
    [original, { index: undefined }, /specify an explicit zero-based index/],
    [original, { index: 9 }, /index 9 is absent/],
    [original, { index: 0 }, /does not match direct/],
    [original + original, {}, /found 2/],
    [original, { selector: "text:alpha_z.*" }, /found 0/],
    [" " + original, {}, /found 0/],
    [original, { selector: "text:unrecorded:" }, /found 0/],
    ["alpha_z coefficients: NaN 11.780971282 40.7070301858\n", {}, /non-finite/],
    ["alpha_z coefficients: 4 11 1e999\n", {}, /non-finite/],
    ["alpha_z coefficients: 4 11 coefficient40.7070301858\n", {}, /absent/],
    [original.replace("40.7070301858", "40.7066666667"), {}, /does not match direct/],
  ]) {
    const result = check(body, overrides);
    assert.equal(result.passed, false, JSON.stringify({ body, overrides }));
    assert.match(result.detail, message);
    assert.match(result.detail, /row.cell_verification/);
    assert.match(result.detail, /never change recorded values/);
  }
  for (const nonOriginal of [".brain/input/run.log", "source/summary.md", "source/values.json"]) {
    put(dir, nonOriginal, nonOriginal.endsWith(".json") ? JSON.stringify({ coefficient: 40.7070301858 }) : original);
    const plan = structuredClone(spec);
    plan.source_paths = [nonOriginal]; plan.rows[0].source_paths = [nonOriginal];
    put(dir, ARTIFACTS.outlineV1, { table_plan: [plan] });
    assert.match(tablePlanCheck(dir).detail, /found 0/);
  }
  put(dir, source, original); put(dir, "source/duplicate.txt", original);
  const duplicated = structuredClone(spec);
  duplicated.rows[0].source_paths.push("source/duplicate.txt");
  put(dir, ARTIFACTS.outlineV1, { table_plan: [duplicated] });
  assert.match(tablePlanCheck(dir).detail, /found 2/);
});

test("explicit high display precision verifies tiny log measurements without a near-zero tolerance bypass", (t) => {
  const dir = fixture(t);
  const source = "source/tiny.txt";
  put(dir, source, "residual norm: 1.00957e-11\n");
  const spec = { ...table, columns: ["Residual"], source_paths: [source],
    calculation: "Direct extraction of the recorded maximum absolute residual in the log.",
    rows: [{ label: "Recorded residual", values: [1.00957e-11], source_paths: [source],
      cell_verification: [{ selector: "text:residual norm:", operation: "direct", decimals: 25 }] }] };
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.equal(publishTables(dir), 1);
  spec.rows[0].values[0] = 1.00967e-11;
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.match(tablePlanCheck(dir).detail, /does not match direct/);
  delete spec.rows[0].cell_verification[0].decimals;
  put(dir, ARTIFACTS.outlineV1, { table_plan: [spec] });
  assert.match(tablePlanCheck(dir).detail, /does not match direct/);
});

const texAvailable = spawnSync("pdflatex", ["--version"]).status === 0 && spawnSync("bibtex", ["--version"]).status === 0;
test("staging nested TeX, tables, figures and bibliography produces a real reviewable build", { skip: !texAvailable || !poppler }, async (t) => {
  const dir = fixture(t);
  put(dir, ARTIFACTS.outlineV1, { table_plan: [table] });
  publishTables(dir);
  put(dir, ARTIFACTS.finalTex, "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{sections/results}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n");
  put(dir, ".brain/manuscript/sections/results.tex", "Results supported by measurements~\\cite{measured}.\\input{tables/main}\n\\includegraphics[width=1cm]{figures/nested/figure.pdf}");
  put(dir, ".brain/manuscript/figures/nested/figure.pdf", pdf(1));
  put(dir, "template/styles/extra.bbx", "% bundled bibliography style\n");
  put(dir, "template/references.bib", "@article{wrong,title={Wrong}}\n");
  put(dir, ARTIFACTS.references, "@article{measured,author={Test Author},title={Measured results},journal={Test Journal},year={2025}}\n");
  put(dir, ".brain/manuscript/review.json", { ready: true });
  put(dir, ".brain/manuscript/unused.py", "must not be staged");
  const staged = stageBuildDir(dir, join(dir, ARTIFACTS.finalTex));
  assert.equal(digestFile(join(staged, "tables/main.tex")), digestFile(join(dir, ".brain/manuscript/tables/main.tex")));
  assert.equal(digestFile(join(staged, "references.bib")), digestFile(join(dir, ARTIFACTS.references)));
  assert.ok(!readdirSync(staged).includes("review.json"));
  assert.ok(!readdirSync(staged).includes("unused.py"));
  assert.ok(readdirSync(join(staged, "styles")).includes("extra.bbx"));
  const built = await compileLatex({ cwd: staged, jobName: "manuscript" });
  assert.equal(built.ok, true, built.errors.join("\n"));
  assert.equal(built.unresolvedCitationMarks, 0);
  copyFileSync(built.pdf, join(dir, ARTIFACTS.finalPdf));
  put(dir, ARTIFACTS.buildReport, { ok: built.ok, source: ARTIFACTS.finalTex, pdf: ARTIFACTS.finalPdf,
    pages: built.pages, errors: built.errors, built_at: new Date().toISOString() });
  const rt = runtime(dir, [JSON.stringify(approved)]);
  await reviewManuscript({ runtime: rt, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 });
  assert.equal(manuscriptReadiness(dir).passed, true);
  rmSync(join(dir, ".brain/manuscript/sections/results.tex"));
  assert.match(manuscriptReadiness(dir).detail, /Stale build input manifest/);
});

test("staging rejects symlinks and invalid output names without altering existing builds", (t) => {
  const dir = fixture(t); build(dir);
  const before = digestFile(join(dir, ".brain/tmp/build/manuscript.pdf"));
  assert.throws(() => stageBuildDir(dir, join(dir, ARTIFACTS.finalTex), "../escape"), /Unsafe/);
  symlinkSync(join(dir, "source/BRIEF.md"), join(dir, ".brain/manuscript/injected.tex"));
  assert.throws(() => stageBuildDir(dir, join(dir, ARTIFACTS.finalTex)), /symlink/);
  assert.equal(digestFile(join(dir, ".brain/tmp/build/manuscript.pdf")), before);
});

test("review context prioritizes mapped evidence, discloses omissions and bounds the actual prompt", { skip: !poppler }, async (t) => {
  const dir = fixture(t); build(dir);
  put(dir, ".brain/input/000-large.txt", "UNRELATED_LARGE_INPUT".repeat(10000));
  put(dir, ".brain/input/important.txt", "Critical measured evidence: 81.2.");
  put(dir, ARTIFACTS.materialsMap, { reading: [{ path: ".brain/input/important.txt" }], facts: [] });
  const rt = runtime(dir, [JSON.stringify(approved)]);
  const reviewed = await reviewManuscript({ runtime: rt, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 });
  assert.equal(reviewed.ready, true);
  const text = rt.calls[0].parts[0].text;
  assert.ok(Buffer.byteLength(text) < 170 * 1024);
  assert.match(text, /Critical measured evidence/);
  assert.match(text, /000-large.txt/);
  assert.match(text, /No file has been truncated/);
  assert.doesNotMatch(text, /UNRELATED_LARGE_INPUT/);
  const attempt = readdirSync(join(dir, ".po-run/reviews"))[0];
  const selection = JSON.parse(readFileSync(join(dir, ".po-run/reviews", attempt, "context-selection.json")));
  assert.equal(selection.files.find((entry) => entry.path.endsWith("000-large.txt")).status, "omitted");
  put(dir, ARTIFACTS.outlineV1, { table_plan: [], research_claims: [{ claim: "Critical", evidence_paths: [".brain/input/000-large.txt"] }] });
  const next = runtime(dir, [JSON.stringify(approved)]);
  const blocked = await reviewManuscript({ runtime: next, workspace: dir, sourceRel: ARTIFACTS.finalTex, timeoutMs: 30000 });
  assert.equal(blocked.ready, false);
  assert.match(manuscriptReadiness(dir).detail, /Provide scoped, readable evidence/);
});

test("submission refuses unowned identical files, extra files, and changed source on resume", (t) => {
  const dir = fixture(t); build(dir); exportSubmission(dir);
  put(dir, "submission/user-notes.txt", "User notes");
  assert.throws(() => exportSubmission(dir), /refusing to overwrite/);
  rmSync(join(dir, "submission/user-notes.txt"));
  put(dir, ARTIFACTS.finalTex, "Changed manuscript");
  assert.throws(() => exportSubmission(dir), /refusing to overwrite/);
  rmSync(join(dir, ".po-run/submission.json"));
  assert.throws(() => exportSubmission(dir), /refusing to overwrite/);
});
