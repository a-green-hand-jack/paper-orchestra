import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserFacingError } from "./errors.js";
import { ARTIFACTS, BRAIN_DIR, BRIEF_FILE, TEMPLATE_DIR } from "./paths.js";
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
  const base: Record<string, string> = {
    cutoff_date: scope.research_cutoff,
    bibliography_mode: scope.bibliography_mode ?? "seed",
  };
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
  triage: [ARTIFACTS.materialsMap],
  outline: [ARTIFACTS.outline],
  // references.bib and citation_map.json are written by the controller before
  // this stage runs, so the model is asked only for the synthesis artifacts.
  literature: [ARTIFACTS.outlineV1, ARTIFACTS.updatedTemplate],
  // Nothing: the plotting stage returns a script in the chat, and the
  // CONTROLLER executes it and writes both artifacts. A model that wrote
  // plotting_results.json itself would be recording figures it only claims to
  // have rendered, which is the whole failure mode these artifacts exist to
  // rule out.
  plotting: [],
  section_writing: [ARTIFACTS.rawDraft],
  refinement: [ARTIFACTS.finalTex],
};

/** Workspace-relative path, but only when it is actually there. */
function ifPresent(workspace: string, rel: string): string[] {
  return existsSync(join(workspace, rel)) ? [rel] : [];
}

/**
 * Inputs a stage may read, phrased for the prompt.
 *
 * Every content stage reads THE MATERIALS. That is the correction this file
 * carries: the read list used to name two synthesized documents and nothing
 * else, so whatever the triage stage did not copy into them was invisible for
 * the rest of the run -- a lossy funnel that no later stage could see past. A
 * writer that needs the actual table now goes and reads the actual table.
 *
 * `materials.json` accompanies them when it exists. It is a map, not a
 * substitute: it says which of several hundred files are worth opening and
 * carries the grounded numbers, so a large input stays tractable without any
 * stage being cut off from the source. Every run performs material understanding,
 * including small inputs; conditional references also allow repairing old runs.
 *
 * `template/guidelines.md` is conditional for a different reason: only a venue
 * author kit ships one. Naming a path that is not there taught the model that
 * this list is approximate, which is the opposite of what a read list is for.
 */
function stageInputs(workspace: string, stage: StageId, _scope: Scope): string[] {
  // The brief leads: it is the author's own statement of what the paper must
  // be, and a stage that reads it after the template has already inferred the
  // format from a placeholder file.
  const materials = [
    ...ifPresent(workspace, BRIEF_FILE),
    `${BRAIN_DIR}/input/`,
    "source/",
    ...ifPresent(workspace, `${BRAIN_DIR}/input-manifest.json`),
    ...ifPresent(workspace, ARTIFACTS.materialsMap),
  ];
  const guidelines = ifPresent(workspace, join(TEMPLATE_DIR, "guidelines.md"));
  switch (stage) {
    case "triage":
      // Triage is the producer of the map, not a consumer: it reads the
      // normalized view of everything and the inventory that describes it.
      return [...ifPresent(workspace, BRIEF_FILE), `${BRAIN_DIR}/input/`, "source/",
        ...ifPresent(workspace, `${BRAIN_DIR}/input-manifest.json`), ...guidelines];
    case "outline":
      return [...materials, join(TEMPLATE_DIR, "template.tex"), ...guidelines];
    case "literature":
      return [
        ARTIFACTS.outline,
        ARTIFACTS.citationMap,
        ARTIFACTS.references,
        ...materials,
        join(TEMPLATE_DIR, "template.tex"),
      ];
    case "plotting":
      return [ARTIFACTS.outline, ...materials];
    case "section_writing":
      return [
        ARTIFACTS.outlineV1,
        ARTIFACTS.citationMap,
        ARTIFACTS.updatedTemplate,
        ARTIFACTS.figuresInfo,
        ...ifPresent(workspace, ARTIFACTS.plottingResults),
        ...ifPresent(workspace, ARTIFACTS.figuresDir),
        ...ifPresent(workspace, `${BRAIN_DIR}/manuscript/tables/`),
        ...materials,
        ...guidelines,
      ];
    case "refinement":
      return [ARTIFACTS.rawDraft, ...ifPresent(workspace, ARTIFACTS.finalTex),
        `${BRAIN_DIR}/manuscript/review.json`, ARTIFACTS.outlineV1, ARTIFACTS.citationMap,
        ...ifPresent(workspace, ARTIFACTS.figuresInfo), ...ifPresent(workspace, ARTIFACTS.figuresDir),
        ...ifPresent(workspace, ARTIFACTS.plottingResults),
        ...ifPresent(workspace, `${BRAIN_DIR}/manuscript/tables/`),
        ...ifPresent(workspace, ARTIFACTS.buildReport), ...materials, ...guidelines];
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
  const inputs = [...stageInputs(workspace, stage, scope), ...ifPresent(workspace, ".brain/raw/data_analysis.json"),
    ...ifPresent(workspace, ".brain/manuscript/table_presentation.json")];
  const citationKeys = extra.citation_keys?.trim();

  // Plotting is the one stage whose product is a REPLY, not a file: the model
  // returns a script, the controller runs it and writes the artifacts. The
  // generic contract below says the opposite ("write files, do not print into
  // the conversation"), which would be precisely wrong here.
  if (stage === "plotting") {
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
      "Runtime data files (controller-provided source-to-script mapping):",
      extra.data_files?.trim() || "No runtime mapping supplied. Do not guess copied paths or invent replacement data.",
      "",
      "Rules:",
      "- Return the script IN YOUR REPLY, in one ```python fenced block. Do not write",
      "  it to a file: the controller executes what you return and writes every",
      "  artifact itself, from what actually rendered.",
      "- After the fenced block, give the figure's caption on a line beginning",
      "  `Caption:`. Plain text, no markdown, no `Figure N:` prefix -- LaTeX numbers",
      "  figures itself.",
      "- `source/` and `template/` are read-only inputs. Never modify them.",
      "- Read original data_source files using workspace tools to understand their actual fields.",
      "  Script reads use only the declared copies under data/ at the mapped runtime paths.",
      "- The script runs with no network in its own directory. Do not fetch data,",
      "  reach outside that directory, or replace missing source data with fabricated literals.",
    ].join("\n");
  }

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
    ...(["section_writing", "refinement"].includes(stage) ? [
      "You may additionally write `.brain/manuscript/table_presentation.json` for presentation-only table corrections.",
      "Shape: {\"table_id\": {\"caption\": \"...\", \"row_header\": \"Quantity\", \"columns\": [\"...\"], \"row_labels\": [\"...\"]}}.",
      "All fields are optional. Preserve the number/order of columns and rows; never add values, sources or calculations here.",
      "The controller regenerates tables with these labels/captions and the original verified values. Keep using the generated table inputs; do not replace them with handwritten tables.",
    ] : []),
    ...(citationKeys
      ? [
          "",
          "The only permitted citation keys for this run (copy them exactly; never derive a key from a title):",
          citationKeys,
        ]
      : []),
    "",
    ...(existsSync(join(workspace, BRIEF_FILE))
      ? [
          "",
          `\`${BRIEF_FILE}\` is the commissioning brief: the author's own requirements for`,
          "this paper -- venue, length, structure, what each section must contain. Where it",
          "and your defaults disagree, it wins. Explicit locked CLI options take precedence",
          "over the brief; then apply template rules and finally recorded inferences.",
        ]
      : []),
    "",
    "Rules:",
    `- Locked template: ${scope.template_id ?? scope.venue}; selection: ${scope.template_selection ?? "explicit"}.`,
    `- Automatic figure generation: ${scope.use_plotting ? "enabled" : "disabled; use supplied figures only"}.`,
    `- Bibliography mode: ${scope.bibliography_mode ?? "seed"}. Only the controller retrieves or changes bibliography records.`,
    ...(scope.target_citations === undefined ? [] : [`- Explicit CLI citation target: ${scope.target_citations}. Record this requirement; never pad unsupported citations.`]),
    "- Never read or reuse inherited finished manuscript prose, PDFs, or equivalent extracted text.",
    "  Templates supply style and structure only. Write independent prose from raw research evidence.",
    "- Read source and extracted results before making claims. Do not run new experiments,",
    "  invent measurements, or hide missing evidence. State supported limitations accurately.",
    "- A raw research folder and optional brief are sufficient inputs; author metadata is not assumed.",
    "  When author metadata is absent, produce an anonymous review manuscript. In generated TeX only,",
    "  replace placeholder author blocks with a template-compatible anonymous author block and remove",
    "  placeholder affiliations, emails and personal metadata. Preserve the document class and style.",
    "- Never invent funding, ethics approval, consent, author contributions or conflicts of interest (COI).",
    "  Absence of information does not establish 'no funding', 'no conflicts' or 'not applicable'.",
    "  Omit unsupported optional personal declarations, not TODOs, sample boilerplate or promises",
    "  such as 'to be completed by authors'. Keep sections required by the brief and applicable venue rules.",
    "  If the selected venue or brief requires an authoritative declaration that is unavailable,",
    "  flag an actual blocker rather than inventing it, silently dropping the requirement or claiming readiness.",
    "  Record it in materials.unresolved or outline requirements when producing those artifacts; otherwise",
    "  report the blocker without inserting editorial instructions into the manuscript.",
    "- Scientific prose and captions must discuss the research, not PaperOrchestra, scaffolds, workspaces,",
    "  pipeline execution or automatic template selection. Do not say the paper was prepared for Nature",
    "  because auto selected its template. Keep that operational rationale outside the manuscript.",
    "  Preserve explicitly required research provenance and boundaries: if the brief requires stating",
    "  that no new simulations were performed, state that accurately. Do not remove required sections",
    "  or factual provenance under this rule.",
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
  const citationFailure = failed.some(
    (check) => check.name === "citation_integrity" || check.name === "citation_floor" || check.name === "latex_assembly",
  );
  return [
    `Stage \`${stage}\` failed controller validation.`,
    "",
    ...failed.map((check) => `- **${check.name}**: ${check.detail}`),
    ...(citationFailure
      ? [
          "",
          "For citation repairs, read `.brain/raw/citation_map.json` and copy its `citation_key` values exactly.",
          "Replace every undefined key; do not infer or synthesize a key from a paper title. Keep only citations",
          "that genuinely support the nearby claim, while meeting the stated citation floor.",
        ]
      : []),
    "",
    "Fix exactly these findings and nothing else. Do not start other work, do not",
    "restructure what already passes, and do not modify anything under `source/` or",
    "`template/` to make a check pass -- if a check appears to require that, stop and",
    "say so instead.",
  ].join("\n");
}
