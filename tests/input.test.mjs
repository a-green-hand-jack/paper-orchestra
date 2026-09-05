import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { importDirectory, importTemplateFiles, normalizeInput, materialsInventory, materialsFitWhole, materialSurvey, materialRole, isSensitive, convertPdfToText, suppliedFiguresDir } from "../dist/input.js";
import { discoverTemplate } from "../dist/template-discovery.js";
import { extractData, inspectPdf, safeSourcePath } from "../dist/input-extraction.js";

function fixture(t) {
  const root = mkdtempSync("/tmp/opencode/input-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
function pdf(text, { graphics = false, pages = 1, raster = false } = {}) {
  const stream = `BT /F1 12 Tf 14 TL 20 700 Td ${text.split("\n").map(line => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ")} ET` +
    (graphics ? "\nq 0 0 1 RG 2 w 30 30 m 200 30 l 200 180 l S 30 40 m 80 60 l 140 120 l 190 160 l S Q" : "") +
    (raster ? "\nq 100 0 0 100 250 250 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /ASCIIHexDecode ID ff0000> EI Q" : "");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array(pages).fill("3 0 R").join(" ")}] /Count ${pages} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const at = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return body;
}

test("credential paths are denied without placeholder exemptions, research tokens survive", () => {
  for (const path of [".env.staging", ".env.example", ".aws/credentials", ".config/tool/auth.json", "service-account.json", "client_secret.json", "config/api-key.txt", "id_ed25519.pub", "private.key", "auth.json.sample", "credentials.backup.json"]) {
    assert.equal(isSensitive(path), true, path);
  }
  for (const path of ["token_efficiency_main.jpg", "train_token_amber.py", "notes/tokenization.md", "results.csv"]) assert.equal(isSensitive(path), false, path);
});

test("import exclusions and unsafe entries are inventoried and never surveyed", async t => {
  const root = fixture(t), raw = join(root, "raw"), work = join(root, "work");
  put(raw, "notes.md", "Unfinished research notes and hypotheses.");
  put(raw, ".env.example", "synthetic placeholder, not a credential");
  put(raw, "paper.md", "SHOULD_NOT_REACH_SURVEY");
  put(raw, "submission.pdf", pdf("SHOULD_NOT_REACH_SOURCE"));
  put(raw, "analysis.md", "# Abstract\nA\n# Introduction\nB\n# Methods\nC\n# Results\nD\n# Conclusion\nE");
  symlinkSync(join(raw, ".env.example"), join(raw, "linked.txt"));
  put(raw, "dist/old.txt", "build output");
  const imported = importDirectory(raw, join(work, "source"));
  assert.deepEqual(imported.files, ["notes.md"]);
  assert.equal(imported.skippedByReason.sensitive, 1);
  assert.equal(imported.skippedByReason.manuscript, 3);
  assert.equal(imported.skippedByReason.symlink, 1);
  assert.doesNotMatch(materialSurvey(raw, 4000), /SHOULD_NOT|synthetic placeholder|# Abstract/);
  await normalizeInput(work);
  const inventory = materialsInventory(work);
  assert.match(inventory, /sensitive; excluded/);
  assert.match(inventory, /manuscript; excluded/);
  assert.match(inventory, /symlink/);
  assert.equal(existsSync(join(work, "source/paper.md")), false);
});

test("PDF paths cannot collide with text files, directories, or other PDFs", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  put(raw, "notes/result.pdf", pdf("step score\n1 42\n2 43"));
  put(raw, "notes/result.md", "original markdown");
  put(raw, "notes/result.pdf.text.md", "original suffix file");
  put(raw, "results/result.pdf", pdf("step score\n1 53\n2 54"));
  put(raw, "results/result.pdf.text.md/notes.txt", "directory collision");
  importDirectory(raw, join(root, "source"));
  const normalized = await normalizeInput(root);
  assert.deepEqual(normalized.unreadable, []);
  const entries = JSON.parse(readFileSync(join(root, normalized.manifest), "utf8"));
  const outputs = entries.filter(e => e.status === "readable").map(e => e.normalized);
  assert.equal(new Set(outputs).size, 5);
  assert.equal(readFileSync(join(root, ".brain/input/notes/result.md"), "utf8"), "original markdown");
  assert.equal(readFileSync(join(root, ".brain/input/notes/result.pdf.text.md"), "utf8"), "original suffix file");
  assert.match(readFileSync(join(root, entries.find(e => e.source === "notes/result.pdf").normalized), "utf8"), /1 42/);
  assert.equal(existsSync(join(root, "source/notes/result.pdf")), false);
  assert.match(materialsInventory(root), /pdf.text.1.md/);
  assert.equal(materialsFitWhole(root), false, "bounded PDF extraction is not a complete read");
});

test("standalone PDF conversion uses .pdf.text.md and refuses overwrite/traversal", async t => {
  const root = fixture(t), file = put(root, "results.pdf", pdf("accuracy = 0.91\nlatency_ms = 4"));
  const output = await convertPdfToText(file, join(root, "out"));
  assert.match(output, /results\.pdf\.text\.md$/);
  await assert.rejects(convertPdfToText(file, join(root, "out")), /overwrite/);
  await assert.rejects(convertPdfToText(file, join(root, "out"), "../escape.pdf"), /escapes/);
});

test("unreadable and malformed imports cannot pass the small-input optimization", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  put(raw, "notes.md", "some notes");
  put(raw, "results.pdf", "not a PDF");
  put(raw, "results.bin", Buffer.from([0, 1, 2]));
  importDirectory(raw, join(root, "source"));
  const result = await normalizeInput(root);
  assert.deepEqual(result.unreadable.sort(), ["results.bin", "results.pdf"]);
  assert.equal(materialsFitWhole(root), false);
  assert.match(materialsInventory(root), /1 unreadable, 1 excluded/);
  assert.match(materialsInventory(root), /unknown; excluded/);
  assert.match(materialsInventory(root), /PDF extraction failed/);
  const small = join(root, "small");
  put(small, "source/notes.md", "some notes");
  await normalizeInput(small);
  assert.equal(materialsFitWhole(small), true);
});

test("neutral PDF names stay unknown until inspection; empirical rows do not require filename keywords", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  for (const name of ["appendix.pdf", "ray-trace-data.pdf", "arbitrary.pdf", "results.pdf"]) {
    assert.equal(materialRole(name), "unknown", name);
    put(raw, name, pdf("UNRELEASED_LABEL\n0 1.5 0.01\n1 1.7 0.02"));
  }
  const imported = importDirectory(raw, join(root, "source"));
  assert.equal(imported.files.length, 4);
  assert.ok(imported.files.every(file => file.endsWith(".pdf.text.md")));
  const result = await normalizeInput(root);
  const entries = JSON.parse(readFileSync(join(root, result.manifest), "utf8"));
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.equal(entry.role, "research");
    assert.equal(entry.sufficiency, "partial");
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(root, "source", entry.source)), false);
    const preview = readFileSync(join(root, entry.normalized), "utf8");
    assert.match(preview, /0 1.5 0.01/);
    assert.doesNotMatch(preview, /UNRELEASED_LABEL/);
    assert.match(preview, /Do not infer column meanings/);
  }
  assert.equal(materialsFitWhole(root), false);
  assert.match(materialsInventory(root), /sufficiency: partial/);
});

test("ambiguous prose is quarantined, not labelled a manuscript or counted as sufficient", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  for (const name of ["appendix.pdf", "research-notes.pdf"]) {
    put(raw, name, pdf("PRIVATE_SYNTHETIC_PROSE. These statements do not establish the document's role."));
  }
  const imported = importDirectory(raw, join(root, "source"));
  assert.deepEqual(imported.files, [], "unknown-only inputs retain an unresolved inventory");
  const result = await normalizeInput(root);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.unreadable, ["appendix.pdf", "research-notes.pdf"]);
  const entries = JSON.parse(readFileSync(join(root, result.manifest), "utf8"));
  assert.ok(entries.every(e => e.role === "unknown" && e.status === "excluded" && e.sufficiency === "unresolved"));
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_SYNTHETIC_PROSE/);
  assert.equal(existsSync(join(root, "source/appendix.pdf")), false);
  assert.match(materialsInventory(root), /not established manuscripts/);
  assert.equal(materialsFitWhole(root), false);
  await assert.rejects(convertPdfToText(join(raw, "appendix.pdf"), join(root, "out")), /unknown: ambiguous/);
  assert.equal(existsSync(join(root, "out/appendix.pdf.text.md")), false);
});

test("explicit PDFs are excluded without inspection and disguised manuscripts release no prose", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  put(raw, "notes.md", "Independent unfinished research notes.");
  put(raw, "finished-paper.pdf", "deliberately not a PDF: should never reach a parser");
  const explicit = inspectPdf(raw, "finished-paper.pdf");
  assert.equal(explicit.role, "manuscript");
  assert.match(explicit.reason, /content not inspected/);
  put(raw, "results.pdf", pdf("Abstract\nSYNTHETIC_FINISHED_PROSE\nIntroduction\nRelated Work\nConclusion\n1 42\n2 43"));
  const imported = importDirectory(raw, join(root, "source"));
  assert.deepEqual(imported.files, ["notes.md"]);
  const result = await normalizeInput(root);
  const entries = JSON.parse(readFileSync(join(root, result.manifest), "utf8"));
  assert.equal(entries.find(e => e.source === "results.pdf").role, "manuscript");
  assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC_FINISHED_PROSE/);
  assert.equal(existsSync(join(root, "source/results.pdf")), false);
});

test("normalization refuses raw PDFs that bypassed the import quarantine", async t => {
  const root = fixture(t);
  put(root, "source/neutral.pdf", pdf("1 2\n3 4"));
  await assert.rejects(normalizeInput(root), /raw PDFs in source.*reimport/);
  put(root, "raw/neutral.pdf", pdf("1 2\n3 4"));
  assert.throws(() => importDirectory(join(root, "raw"), join(root, "source")), /outside the writer workspace/);
});

test("authored single-page figure PDFs retain publishing paths and get figure inventory entries", async t => {
  const tmp = fixture(t), raw = join(tmp, "raw"), work = join(tmp, "work");
  const chart = pdf("Epoch\nAccuracy\nBaseline", { graphics: true });
  put(raw, "study/figures/curve.pdf", chart);
  put(raw, "study/figures/geometry.pdf", pdf("", { graphics: true }));
  const imported = importDirectory(raw, join(work, "source"));
  assert.deepEqual(imported.files, ["study/figures/curve.pdf", "study/figures/geometry.pdf"]);
  assert.equal(readFileSync(join(work, "source/study/figures/curve.pdf"), "utf8"), chart);
  assert.equal(suppliedFiguresDir(work), "source/study/figures");
  const result = await normalizeInput(work);
  assert.deepEqual(result.unreadable, []);
  assert.equal(result.files.length, 2);
  const entries = JSON.parse(readFileSync(join(work, result.manifest), "utf8"));
  assert.ok(entries.every(e => e.role === "figure" && e.status === "readable" && e.sufficiency === "partial"));
  for (const entry of entries) {
    assert.equal(entry.imported, entry.source);
    assert.equal(entry.extractor, "pdf-figure-v1");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const metadata = readFileSync(join(work, entry.normalized), "utf8");
    assert.match(metadata, /Publishing path:/);
    assert.doesNotMatch(metadata, /Baseline|Accuracy|Epoch/);
  }
  assert.match(materialsInventory(work), /figure; readable/);
  assert.equal(materialsFitWhole(work), false);
});

test("figure directories do not admit manuscripts, narrative, multipage, raster, blank, or vendored PDFs", async t => {
  const tmp = fixture(t), raw = join(tmp, "raw"), work = join(tmp, "work");
  put(raw, "notes.md", "independent experiment notes");
  put(raw, "figures/final-paper.pdf", "not opened by a PDF parser");
  put(raw, "figures/article.pdf", pdf("Abstract\nIntroduction\nRelated Work\nConclusion", { graphics: true }));
  put(raw, "figures/narrative.pdf", pdf("This synthetic paragraph describes a completed scientific investigation and must never be published as a supplied figure.", { graphics: true }));
  put(raw, "figures/two-pages.pdf", pdf("Epoch", { graphics: true, pages: 2 }));
  put(raw, "figures/scan.pdf", pdf("", { graphics: true, raster: true }));
  put(raw, "figures/blank.pdf", pdf(""));
  put(raw, "vendor/figures/curve.pdf", pdf("Epoch", { graphics: true }));
  put(raw, "bundle/package.json", "{}");
  put(raw, "bundle/figures/curve.pdf", pdf("Epoch", { graphics: true }));
  assert.equal(inspectPdf(raw, "figures/final-paper.pdf").role, "manuscript");
  const imported = importDirectory(raw, join(work, "source"));
  assert.ok(imported.files.every(file => !file.endsWith(".pdf")));
  const result = await normalizeInput(work);
  const entries = JSON.parse(readFileSync(join(work, result.manifest), "utf8"));
  assert.equal(entries.find(e => e.source === "figures/article.pdf").role, "manuscript");
  for (const name of ["figures/narrative.pdf", "figures/two-pages.pdf", "figures/scan.pdf", "figures/blank.pdf", "vendor/figures/curve.pdf", "bundle/figures/curve.pdf"]) {
    assert.equal(entries.find(e => e.source === name).role, "unknown", name);
    assert.equal(existsSync(join(work, "source", name)), false);
  }
  assert.equal(suppliedFiguresDir(work), null);
});

test("figure admission is bound to the inspected bytes, not just a mutable role label", async t => {
  const tmp = fixture(t), raw = join(tmp, "raw"), work = join(tmp, "work");
  put(raw, "figures/curve.pdf", pdf("Epoch", { graphics: true }));
  importDirectory(raw, join(work, "source"));
  const admitted = join(work, "source/figures/curve.pdf");
  chmodSync(admitted, 0o600);
  writeFileSync(admitted, pdf("Abstract\nIntroduction\nRelated Work"));
  assert.equal(suppliedFiguresDir(work), null);
  await assert.rejects(normalizeInput(work), /raw PDFs in source/);
});

test("scans and inspection-budget overflow are unresolved, not manuscripts", async t => {
  const tmp = fixture(t), root = join(tmp, "work"), raw = join(tmp, "raw");
  put(raw, "00-scan.pdf", pdf(""));
  for (let i = 1; i <= 32; i++) put(raw, `${String(i).padStart(2, "0")}-unknown.pdf`, "malformed synthetic PDF");
  importDirectory(raw, join(root, "source"));
  const result = await normalizeInput(root);
  const entries = JSON.parse(readFileSync(join(root, result.manifest), "utf8"));
  assert.equal(entries.length, 33);
  assert.ok(entries.every(e => e.role === "unknown" && e.sufficiency === "unresolved"));
  assert.match(entries.find(e => e.source === "00-scan.pdf").reason, /without extractable text/);
  assert.match(entries.find(e => e.source === "32-unknown.pdf").reason, /inspection budget exhausted/);
  assert.deepEqual(result.files, []);
});

test("unreadable raw imports remain visible and prevent read-whole", { skip: process.getuid?.() === 0 }, async t => {
  const root = fixture(t), raw = join(root, "raw"), work = join(root, "work");
  put(raw, "notes.md", "available evidence");
  const blocked = put(raw, "measurements.csv", "score\n1\n");
  chmodSync(blocked, 0);
  try {
    const result = importDirectory(raw, join(work, "source"));
    assert.deepEqual(result.files, ["notes.md"]);
    assert.equal(result.skippedByReason["unreadable or unsafe source"], 1);
    await normalizeInput(work);
    assert.equal(materialsFitWhole(work), false);
    assert.match(materialsInventory(work), /measurements.csv.*unreadable/);
  } finally { chmodSync(blocked, 0o600); }
});

test("bounded notebook/CSV/JSON/SQLite extraction exposes saved evidence without execution", async t => {
  const root = fixture(t), source = join(root, "source");
  put(source, "runs.csv", "epoch,accuracy\n1,0.5\n2,0.9\n");
  put(source, "metrics.json", JSON.stringify([{ score: 3 }, { score: 5 }]));
  put(source, "runs.jsonl", '{"score": 7}\n{"score": 9}\n');
  put(source, "analysis.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: [`open(${JSON.stringify(join(root, "EXECUTED"))}, 'w').write('bad')`], outputs: [{ output_type: "stream", text: ["accuracy = 0.91\n"] }] }] }));
  const db = join(source, "runs.sqlite");
  const created = spawnSync("python3", ["-I", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE results (step INTEGER, score REAL)'); c.executemany('INSERT INTO results VALUES (?, ?)', [(1, .4), (2, .8)]); c.commit(); c.close()", db]);
  assert.equal(created.status, 0, created.stderr.toString());
  const before = readFileSync(db);
  const result = await normalizeInput(root);
  assert.deepEqual(result.unreadable, []);
  assert.equal(result.files.length, 5);
  assert.equal(existsSync(join(root, "EXECUTED")), false);
  assert.deepEqual(readFileSync(db), before);
  const combined = result.files.map(f => readFileSync(join(root, f), "utf8")).join("\n");
  assert.match(combined, /accuracy = 0.91/);
  assert.match(combined, /numeric_sample_summary/);
  assert.match(combined, /"mean": 4.0/);
  assert.match(combined, /uncheckpointed WAL/);
  assert.match(combined, /Source: "analysis.ipynb"/);
  assert.equal(materialsFitWhole(root), false);
});

test("optional NumPy uses non-pickle arrays or records an unavailable extractor", async t => {
  const root = fixture(t);
  const probe = spawnSync("python3", ["-I", "-c", "import numpy"]);
  if (probe.status !== 0) {
    put(root, "source/results.npy", Buffer.from([0, 1]));
    const result = await normalizeInput(root);
    assert.deepEqual(result.unreadable, ["results.npy"]);
    return;
  }
  mkdirSync(join(root, "source"));
  const generated = spawnSync("python3", ["-I", "-c", "import numpy as np,sys; np.save(sys.argv[1], np.array([1., 3., 5.])); np.save(sys.argv[2], np.array([{'x': 1}], dtype=object))", join(root, "source/results.npy"), join(root, "source/objects.npy")]);
  assert.equal(generated.status, 0);
  const result = await normalizeInput(root);
  assert.deepEqual(result.unreadable, ["objects.npy"]);
  assert.match(readFileSync(join(root, result.files[0]), "utf8"), /"mean": 3.0/);
});

test("finished manuscript is never a template, even as sole main document", t => {
  const root = fixture(t);
  put(root, "main.tex", "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n" + "Completed scientific discussion. ".repeat(80) + "\\end{document}");
  assert.equal(discoverTemplate(root), null);
  put(root, "template.tex", "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n% write here\n\\end{document}");
  assert.equal(discoverTemplate(root).main, "template.tex");
  assert.ok(!discoverTemplate(root).templateFiles.includes("main.tex"));
  assert.equal(materialRole("results/table.tex", "\\begin{tabular}{c}42\\end{tabular}"), "research");
  assert.equal(materialRole("research_notes.md", "# Ideas\n# Experiments\nUnfinished thoughts"), "research");
});

test("bundled multi-file scaffolds remain usable, not mistaken for finished papers", t => {
  const root = fixture(t);
  for (const venue of ["iclr2025", "cvpr2025", "nature-portfolio"]) {
    const template = fileURLToPath(new URL(`../src/templates/${venue}/`, import.meta.url));
    const discovery = discoverTemplate(template);
    assert.equal(discovery?.main, "template.tex", venue);
    const result = importDirectory(template, join(root, venue, "template"));
    assert.ok(result.files.includes("template.tex"), venue);
  }
});

test("template references and explicit source mappings cannot traverse or follow symlinks", async t => {
  const root = fixture(t), raw = join(root, "raw");
  put(raw, "template.tex", "\\documentclass{article}\n\\begin{document}\n\\input{../outside}\n\\end{document}");
  put(root, "outside.tex", "outside material");
  assert.equal(discoverTemplate(raw), null);
  assert.throws(() => importTemplateFiles(raw, join(root, "template"), new Map([["../outside.tex", "template.tex"]])), /unsafe source/);
  symlinkSync(root, join(raw, "link"));
  assert.throws(() => safeSourcePath(raw, "link/outside.tex"), /unsafe source entry/);
  await assert.rejects(extractData(raw, "../outside.tex"), /unsafe source/);
  await assert.rejects(extractData(raw, "auth.json"), /sensitive source/);
  put(raw, "template.tex", "\\documentclass{article}\n\\begin{document}\n\\input{link/outside}\n\\end{document}");
  assert.equal(discoverTemplate(raw), null);
  put(raw, "template.tex", "\\documentclass{article}\n\\begin{document}\n\\input{preamble}\n\\end{document}");
  put(raw, "preamble.tex", "\\input{../outside}");
  assert.equal(discoverTemplate(raw), null, "nested references are also checked");
});
