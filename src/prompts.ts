import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserFacingError } from "./errors.js";
import { ARTIFACTS } from "./paths.js";
import { COMMANDS, type StageId } from "./stages.js";
import type { Scope } from "./state/schema.js";
import type { Check } from "./state/schema.js";

/**
 * Substitute only the named placeholders.
 *
 * Deliberately not a template engine. The ported prompts contain literal
 * braces that look exactly like placeholders -- `{cleveref}`, `{key}`,
 * `{figure}`, `\cite{Hu2021LoraLowrank}` -- and a generic engine would either
 * blank them out or throw on them. An allowlist replaces what we mean and
 * leaves LaTeX alone.
 */
export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** Placeholders each stage's command markdown declares. */
export function placeholdersFor(stage: StageId, scope: Scope, extra: Record<string, string> = {}) {
  const base: Record<string, string> = { cutoff_date: scope.research_cutoff };
  return { ...base, ...extra };
}

/** Load a stage's command markdown from the workspace, stripping the header comment. */
export function loadCommand(workspace: string, stage: StageId): string {
  const path = join(workspace, ".opencode", "commands", `${COMMANDS[stage]}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new UserFacingError(
      `missing command markdown for stage "${stage}" at ${path}; ` +
        "the workspace's .opencode assets are incomplete",
    );
  }
  return raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
}

/** Files a stage must produce, phrased for the prompt. */
const STAGE_OUTPUTS: Record<StageId, readonly string[]> = {
  outline: [ARTIFACTS.outline],
  literature: [ARTIFACTS.references, ARTIFACTS.citationMap, ARTIFACTS.outlineV1],
  plotting: [ARTIFACTS.plottingResults, ARTIFACTS.figuresInfo],
  section_writing: [ARTIFACTS.rawDraft],
  refinement: [ARTIFACTS.finalTex],
};

/** Inputs a stage may read, phrased for the prompt. */
function stageInputs(stage: StageId, scope: Scope): string[] {
  const source = [
    `source/${scope.idea_filename}`,
    `source/${scope.experimental_log_filename}`,
  ];
  switch (stage) {
    case "outline":
      return [...source, "template/template.tex", "template/guidelines.md"];
    case "literature":
      return [ARTIFACTS.outline, ...source, "template/template.tex"];
    case "plotting":
      return [ARTIFACTS.outline, ...source];
    case "section_writing":
      return [
        ARTIFACTS.outlineV1,
        ARTIFACTS.citationMap,
        ARTIFACTS.updatedTemplate,
        ARTIFACTS.figuresInfo,
        "template/guidelines.md",
      ];
    case "refinement":
      return [ARTIFACTS.rawDraft, ARTIFACTS.citationMap, "template/guidelines.md"];
  }
}

/**
 * Build a stage prompt: the ported system prompt, plus the workspace contract.
 *
 * The contract is stated explicitly because the controller, not the model,
 * decides when a stage is done. Saying so in the prompt removes the incentive
 * to claim completion, and naming the exact output path removes the guesswork
 * that made the Python's "identify missing sections" instruction unreliable.
 */
export function buildStagePrompt(
  workspace: string,
  stage: StageId,
  scope: Scope,
  extra: Record<string, string> = {},
): string {
  const body = substitute(loadCommand(workspace, stage), placeholdersFor(stage, scope, extra));
  const outputs = STAGE_OUTPUTS[stage];
  const inputs = stageInputs(stage, scope);

  return [
    body,
    "",
    "---",
    "",
    "## Workspace contract",
    "",
    `You are working inside a paper-orchestra run workspace. Stage: \`${stage}\`.`,
    "",
    "Read only these paths:",
    ...inputs.map((path) => `- \`${path}\``),
    "",
    "Write exactly these paths:",
    ...outputs.map((path) => `- \`${path}\``),
    "",
    "Rules:",
    "- `source/` and `template/` are read-only inputs. Never modify them, and never",
    "  satisfy a requirement by editing them.",
    "- A controller validates your output against schemas and content checks after",
    "  you finish. It does not read your closing message, so stating that you are",
    "  done has no effect. Write the files.",
    "- Write files directly with your editing tools. Do not print the artifact into",
    "  the conversation instead of writing it.",
    "- Leave no `{{...}}` placeholders and no unresolved TODO markers.",
  ].join("\n");
}

/**
 * Build the single remediation prompt a failed stage gets.
 *
 * The failed check's name and detail go in verbatim, which is why every
 * validator detail is phrased as the expectation it wants met: the check
 * message is the repair instruction.
 */
export function buildRemediationPrompt(stage: StageId, failed: readonly Check[]): string {
  return [
    `Stage \`${stage}\` failed controller validation.`,
    "",
    ...failed.map((check) => `- **${check.name}**: ${check.detail}`),
    "",
    "Fix exactly these findings and nothing else. Do not start other work, do not",
    "restructure what already passes, and do not modify anything under `source/` or",
    "`template/` to make a check pass -- if a check appears to require that, stop and",
    "say so instead.",
  ].join("\n");
}
