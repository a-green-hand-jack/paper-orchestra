import { join } from "node:path";

/**
 * Workspace layout. Issue #1 fixes these names, so they live in one place and
 * every module derives from here rather than re-joining string literals.
 *
 *   <workspace>/
 *   |-- .brain/{input,raw,manuscript,tmp}
 *   |-- source/     imported materials, read-only, digested
 *   |-- template/   selected LaTeX template, read-only, digested
 *   |-- .opencode/  agents, commands, opencode.json
 *   `-- .po-run/{run.json,session.json,checkpoints/,logs/}
 */
export const BRAIN_DIR = ".brain";
export const SOURCE_DIR = "source";
export const TEMPLATE_DIR = "template";
export const OPENCODE_DIR = ".opencode";
export const RUN_DIR = ".po-run";

/**
 * The commissioning brief, when the caller supplied one.
 *
 * Under `source/` because it IS an input: it is the author's statement of what
 * the paper must be, it is covered by `source_digest`, and it is read-only for
 * the same reason the rest of the materials are. Written by `prepare` before
 * the digests are computed, so a brief cannot be introduced or edited after
 * the lock.
 *
 * It exists because a brief does not always arrive as a file in a directory.
 * A Harbor container renders one and hands it over as a STRING -- one location
 * plus one instruction is the whole contract -- and with nowhere to put it, the
 * venue, the page limit and the per-section requirements it carries were simply
 * dropped.
 */
export const BRIEF_FILE = join(SOURCE_DIR, "BRIEF.md");

/** Directories excluded from input walks and digests. */
export const INTERNAL_DIRS: readonly string[] = [
  ".git",
  BRAIN_DIR,
  OPENCODE_DIR,
  RUN_DIR,
  "node_modules",
];

export function paths(workspace: string) {
  const brain = join(workspace, BRAIN_DIR);
  const run = join(workspace, RUN_DIR);
  return {
    workspace,
    /** Normalized inputs the agent reads (e.g. a PDF converted to markdown). */
    brainInput: join(brain, "input"),
    /** Stage artifacts: outline.json, references.bib, citation_map.json. */
    brainRaw: join(brain, "raw"),
    /** The manuscript under construction, plus figures/. */
    brainManuscript: join(brain, "manuscript"),
    /** Scratch space: generated figure scripts, PDF page renders. */
    brainTmp: join(brain, "tmp"),
    source: join(workspace, SOURCE_DIR),
    template: join(workspace, TEMPLATE_DIR),
    opencode: join(workspace, OPENCODE_DIR),
    runDir: run,
    runState: join(run, "run.json"),
    sessionState: join(run, "session.json"),
    checkpoints: join(run, "checkpoints"),
    logs: join(run, "logs"),
  };
}

export type Paths = ReturnType<typeof paths>;

/** Stage artifact paths, relative to the workspace root. */
export const ARTIFACTS = {
  /**
   * The map into the author's materials: what to read, the grounded facts, and
   * what the materials do not say. Absent when the input was small enough that
   * every stage can simply read all of it.
   */
  materialsMap: join(BRAIN_DIR, "raw", "materials.json"),
  outline: join(BRAIN_DIR, "raw", "outline.json"),
  outlineV1: join(BRAIN_DIR, "raw", "outline_v1.json"),
  references: join(BRAIN_DIR, "raw", "references.bib"),
  citationMap: join(BRAIN_DIR, "raw", "citation_map.json"),
  candidates: join(BRAIN_DIR, "raw", "candidates.json"),
  /** Controller-owned record of which potential paid queries were kept or removed. */
  queryPlan: join(BRAIN_DIR, "raw", "query_plan.json"),
  updatedTemplate: join(BRAIN_DIR, "raw", "updated_template.tex"),
  plottingResults: join(BRAIN_DIR, "raw", "plotting_results.json"),
  /** Controller-written LaTeX build report, read by the latex_assembly check. */
  buildReport: join(BRAIN_DIR, "raw", "build.json"),
  figuresDir: join(BRAIN_DIR, "manuscript", "figures"),
  figuresInfo: join(BRAIN_DIR, "manuscript", "figures", "info.json"),
  rawDraft: join(BRAIN_DIR, "manuscript", "raw_draft.tex"),
  finalTex: join(BRAIN_DIR, "manuscript", "final_paper.tex"),
  finalPdf: join(BRAIN_DIR, "manuscript", "final_paper.pdf"),
} as const;
