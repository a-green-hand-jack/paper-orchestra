#!/usr/bin/env node
/**
 * Map a PaperOrchestra workspace onto the Harbor submission contract.
 *
 * Paper-Writing-Exam grades `/workspace/submission/` and requires `main.tex`
 * plus `references.bib`; PaperOrchestra produces
 * `.brain/manuscript/final_paper.tex` and `.brain/raw/references.bib`. This
 * script is the adapter, and it exists as a committed script rather than a
 * handful of `cp` invocations because it is part of the acceptance procedure
 * and has to be re-runnable and reviewable.
 *
 * It deliberately does NOT reuse `stageBuildDir` from src/latexbuild.ts, even
 * though the copy rules are the same. Two reasons:
 *
 *  * `stageBuildDir` writes into `.brain/tmp/build`, which a running controller
 *    is also using -- staging a submission mid-run would collide with it.
 *  * A grader that shares code with the thing it grades is weaker. If
 *    `stageBuildDir` ever omits a file the compile needs, reusing it would hide
 *    that defect from the verifier instead of surfacing it.
 *
 * The verifier copies the submission to a clean directory and compiles there
 * (`tests/test_state.py`), so the submission must be self-contained: the
 * manuscript, the bibliography, every included figure, and every .sty/.bst/.cls
 * plus any file the preamble \inputs.
 *
 * Usage:
 *   node scripts/harbor-submit.mjs <workspace> <submission-dir> [--verify]
 *
 * `--verify` runs the verifier's exact command line, including
 * `-halt-on-error`, which PaperOrchestra's own build does not use.
 */
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const MANUSCRIPT_CANDIDATES = [
  join(".brain", "manuscript", "final_paper.tex"),
  // Fall back so a run that failed at refinement can still be graded: knowing
  // which of the three criteria a partial run meets is the point of a baseline.
  join(".brain", "manuscript", "raw_draft.tex"),
];
const BIB = join(".brain", "raw", "references.bib");
const FIGURES = join(".brain", "manuscript", "figures");
const SUPPORT_EXTENSIONS = new Set([".sty", ".bst", ".cls", ".clo", ".def", ".cfg"]);

function die(message) {
  process.stderr.write(`harbor-submit: ${message}\n`);
  process.exit(1);
}

/** Copy, then force the destination writable: imported inputs are mode 0444. */
function copyWritable(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o644);
}

function walk(root, into = [], prefix = "") {
  if (!existsSync(root)) return into;
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    const rel = prefix ? join(prefix, name) : name;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, into, rel);
    else if (st.isFile()) into.push(rel);
  }
  return into;
}

const [workspace, submission, ...flags] = process.argv.slice(2);
if (!workspace || !submission) {
  die("usage: harbor-submit.mjs <workspace> <submission-dir> [--verify]");
}
if (!existsSync(workspace)) die(`no such workspace: ${workspace}`);

const manuscriptRel = MANUSCRIPT_CANDIDATES.find((rel) => existsSync(join(workspace, rel)));
if (!manuscriptRel) {
  die(`no manuscript found; looked for ${MANUSCRIPT_CANDIDATES.join(" and ")}`);
}

rmSync(submission, { recursive: true, force: true });
mkdirSync(submission, { recursive: true });

const copied = [];

// 1. Template support files. Everything except the template's own main file,
//    which the manuscript replaces.
const templateDir = join(workspace, "template");
for (const rel of walk(templateDir)) {
  if (rel === "template.tex") continue;
  // The template's stub references.bib must not shadow the generated one.
  if (rel === "references.bib") continue;
  copyWritable(join(templateDir, rel), join(submission, rel));
  copied.push(rel);
}

// 2. Figures, minus the controller's info.json manifest.
for (const rel of walk(join(workspace, FIGURES))) {
  if (extname(rel) === ".json") continue;
  copyWritable(join(workspace, FIGURES, rel), join(submission, "figures", rel));
  copied.push(join("figures", rel));
}

// 3. The generated bibliography, under the contract's name.
if (existsSync(join(workspace, BIB))) {
  copyWritable(join(workspace, BIB), join(submission, "references.bib"));
  copied.push("references.bib");
} else {
  process.stderr.write(`harbor-submit: warning: ${BIB} is absent\n`);
}

// 4. The manuscript, as main.tex.
copyWritable(join(workspace, manuscriptRel), join(submission, "main.tex"));
copied.push(`main.tex  (from ${manuscriptRel})`);

const support = copied.filter((rel) => SUPPORT_EXTENSIONS.has(extname(rel)));
process.stdout.write(
  `staged ${copied.length} file(s) into ${submission}\n` +
    `  manuscript: ${manuscriptRel}\n` +
    `  support:    ${support.length ? support.join(", ") : "NONE -- a clean-room compile will fail"}\n` +
    `  figures:    ${copied.filter((r) => r.startsWith("figures/")).length}\n`,
);

// Report anything the manuscript \inputs that did not get staged, since the
// verifier compiles from a copy and an unstaged \input is an instant failure.
const tex = readFileSync(join(submission, "main.tex"), "utf8");
const staged = new Set(walk(submission));
const missing = [];
for (const match of tex.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
  const requested = match[1].trim();
  const candidates = [requested, `${requested}.tex`];
  if (!candidates.some((c) => staged.has(c))) missing.push(requested);
}
for (const match of tex.matchAll(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
  const requested = match[1].trim();
  const hit = [...staged].some(
    (s) => s === requested || s.replace(/\.[^.]+$/, "") === requested.replace(/\.[^.]+$/, ""),
  );
  if (!hit) missing.push(requested);
}
if (missing.length) {
  process.stdout.write(`  UNSTAGED references: ${[...new Set(missing)].join(", ")}\n`);
}

if (!flags.includes("--verify")) process.exit(0);

// The verifier's exact command line. `-halt-on-error` is the difference that
// matters: PaperOrchestra's own build uses nonstopmode and tolerates
// recoverable errors, so a manuscript can pass every internal validator and
// still fail here.
process.stdout.write(`\nverifying with the grader's own command line\n`);
const commands = [
  ["pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"]],
  ["pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"]],
  ["bibtex", ["main"]],
  ["pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"]],
  ["pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"]],
];
let ok = true;
for (const [bin, args] of commands) {
  const run = spawnSync(bin, args, { cwd: submission, encoding: "utf8" });
  const tolerated = bin === "bibtex"; // the grader tolerates bibtex failures
  const status = run.status === 0 ? "ok" : tolerated ? "ignored" : "FAILED";
  process.stdout.write(`  ${bin} ${args[0] ?? ""} -> ${status}\n`);
  if (run.status !== 0 && !tolerated) {
    ok = false;
    const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    process.stdout.write(
      log
        .split("\n")
        .filter((l) => l.startsWith("!") || l.startsWith("l."))
        .slice(0, 12)
        .map((l) => `      ${l}\n`)
        .join(""),
    );
    break;
  }
}
const pdf = join(submission, "main.pdf");
const hasPdf = existsSync(pdf) && statSync(pdf).size > 0;

// Criterion 3: every cited key must be defined in references.bib.
const cited = new Set();
for (const match of tex.matchAll(/\\(?<cmd>[A-Za-z]*cite[A-Za-z]*\*?)(?:\s*\[[^\]]*\]){0,2}\s*\{(?<keys>[^}]*)\}/g)) {
  if (match.groups.cmd.toLowerCase().startsWith("nocite")) continue;
  for (const key of match.groups.keys.split(",")) {
    const k = key.trim();
    if (k) cited.add(k);
  }
}
const bibText = existsSync(join(submission, "references.bib"))
  ? readFileSync(join(submission, "references.bib"), "utf8")
  : "";
const defined = new Set([...bibText.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map((m) => m[1]));
const undefinedKeys = [...cited].filter((k) => !defined.has(k)).sort();

process.stdout.write(
  `\n  criterion 1 submission contract : ${existsSync(join(submission, "main.tex")) && bibText ? "PASS" : "FAIL"}\n` +
    `  criterion 2 clean recompile     : ${ok && hasPdf ? "PASS" : "FAIL"}\n` +
    `  criterion 3 citations defined    : ${undefinedKeys.length === 0 ? "PASS" : `FAIL (${undefinedKeys.length} undefined: ${undefinedKeys.slice(0, 8).join(", ")})`}\n` +
    `  cited=${cited.size} defined=${defined.size}\n`,
);
process.exit(ok && hasPdf && undefinedKeys.length === 0 && bibText ? 0 : 2);
