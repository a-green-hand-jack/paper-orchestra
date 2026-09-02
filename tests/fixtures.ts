import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
