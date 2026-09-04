import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareWorkspace, type PrepareOptions } from "../src/commands/prepare.js";

export function scratchDir(prefix = "po-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Minimal raw materials: an idea, a log, and one supplied figure. */
export function makeRawMaterials(): string {
  const dir = scratchDir("po-raw-");
  writeFileSync(join(dir, "idea_sparse.md"), "# Idea\n\nA temporal adapter for SAM.\n");
  writeFileSync(join(dir, "experimental_log.md"), "# Log\n\nJ&F 52.1 on Ref-AVS.\n");
  mkdirSync(join(dir, "figures"));
  writeFileSync(join(dir, "figures", "overview.png"), "not-really-a-png");
  return dir;
}

/** Minimal LaTeX template with the marker convention both real templates use. */
export function makeTemplate(): string {
  const dir = scratchDir("po-template-");
  writeFileSync(
    join(dir, "template.tex"),
    [
      "\\documentclass[10pt,twocolumn,letterpaper]{article}",
      "\\usepackage{cvpr}",
      "\\begin{document}",
      "%%%%%%%%% ABSTRACT %%%%%%%%%",
      "Abstract here.",
      "%%%%%%%%% ABSTRACT %%%%%%%%%",
      "\\end{document}",
    ].join("\n"),
  );
  writeFileSync(join(dir, "guidelines.md"), "# Guidelines\n\nEight pages excluding references.\n");
  writeFileSync(join(dir, "cvpr.sty"), "% style\n");
  writeFileSync(join(dir, "references.bib"), "");
  return dir;
}

export function prepareOptions(overrides: Partial<PrepareOptions> = {}): PrepareOptions {
  return {
    workspace: join(scratchDir("po-ws-"), "run"),
    rawMaterials: makeRawMaterials(),
    templateDir: makeTemplate(),
    mode: "autonomous",
    headless: true,
    usePlotting: false,
    researchCutoff: "2026-01",
    ideaFilename: "idea_sparse.md",
    experimentalLogFilename: "experimental_log.md",
    networkPolicy: "online",
    defaultModel: null,
    stageModels: {},
    timeoutMultiplier: 1,
    maxLkmCalls: 40,
    targetCitations: 20,
    ...overrides,
  };
}

/** A fully prepared workspace, ready for state and checkpoint assertions. */
export async function prepared(overrides: Partial<PrepareOptions> = {}) {
  const options = prepareOptions(overrides);
  const result = await prepareWorkspace(options);
  return { ...result, workspace: options.workspace, options };
}

/** Defeat the read-only lock the way a careless user or agent would. */
export function tamper(path: string, content: string): void {
  chmodSync(path, 0o644);
  writeFileSync(path, content);
}

/**
 * Materials shaped like a real project directory rather than two curated
 * documents: code, logs, a virtualenv, a symlink, an extensionless file, a
 * name that only looks like a credential, a colliding pair of PDFs, and a
 * previous run's workspace sitting in the same directory.
 *
 * `makeRawMaterials` is deliberately left alone as the *supplied* fixture, so
 * every existing test that calls `prepared()` keeps exercising the path that
 * needs no model.
 */
export function makeMessyRawMaterials(): string {
  const dir = scratchDir("po-messy-");
  const put = (rel: string, body: string): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  put("research_overview.md", "# Idea\n\nA temporal adapter for SAM.\n");
  put("notes/brainstorm.md", "Ablations to run.\n");
  put("src/train.py", "import torch\n\nLR = 3e-4\n");
  put("scripts/run.sh", "#!/bin/bash\npython src/train.py --lr 3e-4\n");
  put("logs/run1.log", "step=100 loss=0.42\n");
  put("results.csv", "metric,value\nJ,43.43\n");
  put("pyproject.toml", "[project]\nname = 'x'\n");
  put("LICENSE", "Apache License 2.0\n");
  // Reads like a credential to an unanchored substring match, but is not one.
  put("tokenizer_notes.md", "BPE vocabulary sizing.\n");
  // Must never be imported: a workspace is checkpointed.
  put(".env", "OPENAI_API_KEY=sk-secret\n");
  // Build artifact whose bytes happen to decode as text.
  put("build/out.pyc", "junk\n");
  put(".venv/lib/python3.11/site-packages/foo.py", "x = 1\n");
  put("__pycache__/train.cpython-311.pyc", "junk\n");
  // A previous run's workspace, which `-o` puts here by default.
  put("po-run-20260101000000/.po-run/run.json", "{}\n");
  put("po-run-20260101000000/source/idea_sparse.md", "stale\n");
  // Same basename in two directories: a flat PDF conversion loses one.
  put("notes/results.pdf", "%PDF-1.4\n");
  put("data/results.pdf", "%PDF-1.4\n");

  symlinkSync("/etc/passwd", join(dir, "sneaky.md"));
  symlinkSync(join(dir, "logs"), join(dir, "latest"));
  return dir;
}

/**
 * A bibliography shaped like a real one rather than a clean one.
 *
 * Every irregularity here was copied from a real 114-entry bibliography,
 * because that is the shape this path has to accept: BibTeX takes all of it,
 * the file compiles, and it is not ours to correct.
 *
 * - a stray comma on its own line before a field
 * - an abstract containing a whole LaTeX document, so braces nest
 * - a mixed-case entry type
 * - one entry with no `year`
 * - two keys for the same paper, one hand-written and one generated
 */
export const MESSY_BIBLIOGRAPHY = [
  "@inproceedings{vqa,",
  "  title={Vqa: Visual question answering},",
  "  author={Antol, Stanislaw and Agrawal, Aishwarya and Parikh, Devi},",
  "  booktitle={Proceedings of the IEEE international conference on computer vision},",
  "  year={2015}",
  ",",
  "  abstract = {We propose the task of free-form VQA. We provide a dataset of",
  "\\documentclass[12pt]{minimal} \\begin{document}$$\\sim$$\\end{document}0.25 M images.}",
  "}",
  "",
  "@ARTICLE{llava,",
  "  title={Visual instruction tuning},",
  "  author={Liu, Haotian and Li, Chunyuan},",
  "  journal={NeurIPS},",
  "  year={2023}",
  "}",
  "",
  "@misc{liu2023visualinstructiontuning,",
  "      title={Visual Instruction Tuning}, ",
  "      author={Haotian Liu and Chunyuan Li},",
  "      year={2023},",
  "      eprint={2304.08485}",
  "}",
  "",
  "@article{math,",
  "  title={Measuring Mathematical Problem Solving With the MATH Dataset},",
  "  author={Hendrycks, Dan and Burns, Collin},",
  "  journal={Sort},",
  "  pages={0--6}",
  "}",
  "",
].join("\n");

/**
 * Materials that carry the author's own bibliography.
 *
 * Otherwise identical to `makeRawMaterials`, so a test can attribute any
 * difference in behaviour to the bibliography alone.
 */
export function makeRawMaterialsWithBibliography(bib = MESSY_BIBLIOGRAPHY): string {
  const dir = makeRawMaterials();
  writeFileSync(join(dir, "references.bib"), bib);
  return dir;
}
