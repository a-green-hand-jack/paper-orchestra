import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import {
  CandidatesSchema,
  CitationMapSchema,
  FigureInfoSchema,
  OutlineSchema,
  PlottingResultsSchema,
} from "./artifacts.js";
import { walkFiles } from "./files.js";
import {
  bibKeys,
  citedKeys,
  documentClass,
  includedGraphics,
  unresolvedMarkers,
} from "./latex.js";
import { ARTIFACTS, paths } from "./paths.js";
import type { StageId } from "./stages.js";
import type { Check, Scope } from "./state/schema.js";

/**
 * Validators return data, never throw.
 *
 * `validate` prints the whole PASS/FAIL table while the controller only needs
 * the first failure, and `detail` is interpolated verbatim into the remediation
 * prompt — so every detail is phrased as the expectation it wants met. The
 * check message IS the repair instruction.
 */
function pass(name: string, detail: string): Check {
  return { name, passed: true, detail };
}
function fail(name: string, detail: string): Check {
  return { name, passed: false, detail };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; check: Check };

/**
 * Read and schema-parse an artifact, converting every failure into a Check.
 *
 * Validators must return data and never throw: `validate` prints the whole
 * PASS/FAIL table, and the controller reads the first failure to build a
 * remediation prompt. An unguarded `JSON.parse` on model-written output would
 * abort both paths on the one input most likely to be malformed.
 */
function parseArtifact<S extends z.ZodTypeAny>(
  workspace: string,
  rel: string,
  schema: S,
  name: string,
): Parsed<z.output<S>> {
  const raw = readIfExists(join(workspace, rel));
  if (raw === null) {
    return { ok: false, check: fail(name, `expected ${rel} to exist`) };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      check: fail(
        name,
        `expected ${rel} to be valid JSON; it does not parse (${(error as Error).message})`,
      ),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    return {
      ok: false,
      check: fail(name, `expected ${rel} to match its schema; ${where}: ${first?.message}`),
    };
  }
  return { ok: true, value: result.data };
}

/** A required artifact, optionally with a floor on its size. */
function artifactExists(workspace: string, rel: string, minBytes = 1): Check {
  const abs = join(workspace, rel);
  const name = `artifact_exists:${rel}`;
  if (!existsSync(abs)) return fail(name, `expected ${rel} to exist; write it before finishing`);
  const size = statSync(abs).size;
  return size >= minBytes
    ? pass(name, `${rel} (${size} bytes)`)
    : fail(name, `expected ${rel} to hold at least ${minBytes} bytes, found ${size}`);
}

/** Parse an artifact against its schema, reporting the first path that fails. */
function schemaValid(workspace: string, rel: string, schema: z.ZodTypeAny): Check {
  const name = `schema_valid:${rel}`;
  const parsed = parseArtifact(workspace, rel, schema, name);
  return parsed.ok ? pass(name, `${rel} matches its schema`) : parsed.check;
}

/**
 * The outline must actually plan a paper.
 *
 * Guards the crash at `plotting_agent.py:258`, where a null `figure_id` is used
 * as a filename via `.replace()`, and the silent degradation where an empty
 * `section_plan` yields a paper with no sections.
 */
function outlineCoverage(workspace: string): Check {
  const name = "outline_coverage";
  const parsed = parseArtifact(workspace, ARTIFACTS.outline, OutlineSchema, name);
  if (!parsed.ok) return parsed.check;
  const outline = parsed.value;

  if (outline.section_plan.length === 0) {
    return fail(name, "expected section_plan to contain at least one section, found none");
  }
  const empty = outline.section_plan.filter((s) => s.subsections.length === 0);
  if (empty.length > 0) {
    return fail(
      name,
      `expected every section to have at least one subsection; these have none: ${empty
        .map((s) => s.section_title)
        .join(", ")}`,
    );
  }
  const ids = outline.plotting_plan.map((p) => p.figure_id);
  const duplicates = ids.filter((id, at) => ids.indexOf(id) !== at);
  if (duplicates.length > 0) {
    return fail(
      name,
      `expected every figure_id to be unique because it becomes a filename; duplicated: ${[
        ...new Set(duplicates),
      ].join(", ")}`,
    );
  }
  return pass(
    name,
    `${outline.section_plan.length} sections, ${outline.plotting_plan.length} planned figures`,
  );
}

/**
 * Every cited key must exist in the bibliography.
 *
 * The Python hands `citation_map.json` to the writer as "reference truth" and
 * never checks what comes back, so an invented key reaches the manuscript and
 * only surfaces as a `?` in the compiled PDF.
 */
function citationIntegrity(workspace: string, manuscriptRel: string): Check {
  const name = "citation_integrity";
  const tex = readIfExists(join(workspace, manuscriptRel));
  const bib = readIfExists(join(workspace, ARTIFACTS.references));
  if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);
  if (bib === null) return fail(name, `expected ${ARTIFACTS.references} to exist`);

  const cited = citedKeys(tex);
  const defined = new Set(bibKeys(bib));
  const undefinedKeys = cited.filter((key) => !defined.has(key));

  if (undefinedKeys.length > 0) {
    return fail(
      name,
      `expected every \\cite key to be defined in references.bib; these are not: ` +
        `${undefinedKeys.join(", ")}. Cite an existing key or remove the citation; ` +
        "do not add entries to the bibliography by hand.",
    );
  }
  if (cited.length === 0) {
    return fail(
      name,
      "expected the manuscript to cite at least one reference from references.bib, found none. " +
        `The bibliography holds ${defined.size} entries available to cite.`,
    );
  }
  return pass(name, `${cited.length} cited keys, all defined in a ${defined.size}-entry bibliography`);
}

/** No two bibliography entries may describe the same paper. */
function literatureDedup(workspace: string): Check {
  const name = "literature_dedup";
  const parsed = parseArtifact(workspace, ARTIFACTS.citationMap, CitationMapSchema, name);
  if (!parsed.ok) return parsed.check;

  const byTitle = new Map<string, string[]>();
  for (const [key, record] of Object.entries(parsed.value)) {
    const normalized = record.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    byTitle.set(normalized, [...(byTitle.get(normalized) ?? []), key]);
  }
  const collisions = [...byTitle.values()].filter((keys) => keys.length > 1);
  if (collisions.length > 0) {
    return fail(
      name,
      `expected one entry per paper; these key groups share a normalized title: ` +
        `${collisions.map((keys) => keys.join("/")).join("; ")}`,
    );
  }
  return pass(name, `${Object.keys(parsed.value).length} distinct references`);
}

/**
 * Every bibliography entry must trace to a retrieval record.
 *
 * Absent from the Python entirely. Because the controller performs retrieval
 * and writes both files, this is mechanically checkable: an entry with no
 * candidate record was added by the model, which is the fabrication case.
 */
function bibliographyProvenance(workspace: string): Check {
  const name = "bibliography_provenance";
  const bib = readIfExists(join(workspace, ARTIFACTS.references));
  if (bib === null) return fail(name, `expected ${ARTIFACTS.references} to exist`);
  if (!existsSync(join(workspace, ARTIFACTS.candidates))) {
    return fail(
      name,
      `expected ${ARTIFACTS.candidates} to exist so every bibliography entry has a provider ` +
        "and provider id recorded",
    );
  }
  const parsed = parseArtifact(workspace, ARTIFACTS.candidates, CandidatesSchema, name);
  if (!parsed.ok) return parsed.check;

  const traced = new Set(parsed.value.map((c) => c.citation_key));
  const untraced = bibKeys(bib).filter((key) => !traced.has(key));
  if (untraced.length > 0) {
    return fail(
      name,
      `expected every references.bib entry to appear in candidates.json with a provider; ` +
        `these do not: ${untraced.join(", ")}`,
    );
  }
  return pass(name, `${traced.size} entries, each traced to a retrieval record`);
}

/** Planned figures must have rendered, and rendered figures must be used. */
function figureCoverage(workspace: string, scope: Scope, manuscriptRel: string | null): Check {
  const name = "figure_coverage";
  const p = paths(workspace);
  if (!existsSync(join(workspace, ARTIFACTS.figuresInfo))) {
    return fail(
      name,
      `expected ${ARTIFACTS.figuresInfo} to list every available figure with its caption`,
    );
  }
  const parsed = parseArtifact(workspace, ARTIFACTS.figuresInfo, FigureInfoSchema, name);
  if (!parsed.ok) return parsed.check;

  const onDisk = new Set(
    walkFiles(p.brainManuscript)
      .filter((rel) => rel.startsWith("figures/") && extname(rel) !== ".json")
      .map((rel) => basename(rel)),
  );

  const missing = parsed.value
    .map((entry) => entry.name)
    .filter((figureName) => !onDisk.has(basename(figureName)));
  if (missing.length > 0) {
    return fail(
      name,
      `expected every figure named in info.json to exist under manuscript/figures/; ` +
        `missing: ${missing.join(", ")}`,
    );
  }

  if (scope.use_plotting) {
    if (!existsSync(join(workspace, ARTIFACTS.plottingResults))) {
      return fail(name, `expected ${ARTIFACTS.plottingResults} to exist when plotting is enabled`);
    }
    const results = parseArtifact(
      workspace,
      ARTIFACTS.plottingResults,
      PlottingResultsSchema,
      name,
    );
    if (!results.ok) return results.check;
    const unrendered = results.value.filter((r) => !r.image_path);
    if (unrendered.length > 0) {
      return fail(
        name,
        `expected every planned figure to render; these produced no image: ` +
          `${unrendered.map((r) => r.figure_id).join(", ")}`,
      );
    }
  }

  if (manuscriptRel) {
    const tex = readIfExists(join(workspace, manuscriptRel));
    if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);
    const used = new Set(includedGraphics(tex).map((path) => basename(path, extname(path))));
    const unused = parsed.value
      .map((entry) => basename(entry.name, extname(entry.name)))
      .filter((stem) => !used.has(stem));
    if (unused.length > 0) {
      return fail(
        name,
        `expected the manuscript to include every available figure; these are never ` +
          `\\includegraphics'd: ${unused.join(", ")}`,
      );
    }
  }

  return pass(name, `${parsed.value.length} figures available and accounted for`);
}

/** The manuscript must remain compatible with the selected venue template. */
function templateCompatibility(workspace: string, manuscriptRel: string): Check {
  const name = "template_compatibility";
  const p = paths(workspace);
  const tex = readIfExists(join(workspace, manuscriptRel));
  if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);

  const templateFiles = walkFiles(p.template);
  const supportExtensions = [".sty", ".bst", ".cls"];
  const support = templateFiles.filter((rel) => supportExtensions.includes(extname(rel)));
  if (support.length === 0) {
    return fail(
      name,
      `expected the template directory to supply at least one .sty/.bst/.cls file; found none`,
    );
  }

  const templateMain = readIfExists(join(p.template, "template.tex"));
  const expectedClass = templateMain ? documentClass(templateMain) : null;
  const actualClass = documentClass(tex);
  if (expectedClass && actualClass && expectedClass !== actualClass) {
    return fail(
      name,
      `expected \\documentclass{${expectedClass}} to match the ${workspaceVenue(workspace)} ` +
        `template, found \\documentclass{${actualClass}}`,
    );
  }
  return pass(name, `${support.length} support file(s), documentclass ${actualClass ?? "unset"}`);
}

function workspaceVenue(workspace: string): string {
  return basename(workspace);
}

/** A finished manuscript must contain no placeholders or deferral markers. */
function noUnresolvedMarkers(workspace: string, manuscriptRel: string): Check {
  const name = "no_unresolved_markers";
  const tex = readIfExists(join(workspace, manuscriptRel));
  if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);
  const markers = unresolvedMarkers(tex);
  if (markers.length > 0) {
    return fail(
      name,
      `expected no unresolved placeholders or TODO markers in the final manuscript; found ` +
        `${markers.length}: ${markers.slice(0, 3).join(" | ")}${markers.length > 3 ? " ..." : ""}`,
    );
  }
  return pass(name, "no placeholders or deferral markers");
}

/**
 * Validate one stage's artifacts.
 *
 * A single function branching on stage rather than a registry, so the full set
 * of checks for a stage is readable in one place.
 */
export function validateStage(workspace: string, stage: StageId, scope: Scope): Check[] {
  switch (stage) {
    case "outline":
      return [
        artifactExists(workspace, ARTIFACTS.outline, 32),
        schemaValid(workspace, ARTIFACTS.outline, OutlineSchema),
        outlineCoverage(workspace),
      ];

    case "literature":
      return [
        artifactExists(workspace, ARTIFACTS.references, 16),
        artifactExists(workspace, ARTIFACTS.citationMap, 2),
        artifactExists(workspace, ARTIFACTS.outlineV1, 32),
        schemaValid(workspace, ARTIFACTS.citationMap, CitationMapSchema),
        schemaValid(workspace, ARTIFACTS.outlineV1, OutlineSchema),
        literatureDedup(workspace),
        bibliographyProvenance(workspace),
      ];

    case "plotting":
      if (!scope.use_plotting) {
        return [
          pass(
            "plotting_disabled",
            "plotting is off for this run; supplied figures are used as-is",
          ),
          figureCoverage(workspace, scope, null),
        ];
      }
      return [
        artifactExists(workspace, ARTIFACTS.plottingResults, 2),
        schemaValid(workspace, ARTIFACTS.plottingResults, PlottingResultsSchema),
        artifactExists(workspace, ARTIFACTS.figuresInfo, 2),
        schemaValid(workspace, ARTIFACTS.figuresInfo, FigureInfoSchema),
        figureCoverage(workspace, scope, null),
      ];

    case "section_writing":
      return [
        artifactExists(workspace, ARTIFACTS.rawDraft, 512),
        citationIntegrity(workspace, ARTIFACTS.rawDraft),
        figureCoverage(workspace, scope, ARTIFACTS.rawDraft),
        templateCompatibility(workspace, ARTIFACTS.rawDraft),
      ];

    case "refinement":
      return [
        artifactExists(workspace, ARTIFACTS.finalTex, 512),
        artifactExists(workspace, ARTIFACTS.finalPdf, 1024),
        citationIntegrity(workspace, ARTIFACTS.finalTex),
        figureCoverage(workspace, scope, ARTIFACTS.finalTex),
        templateCompatibility(workspace, ARTIFACTS.finalTex),
        noUnresolvedMarkers(workspace, ARTIFACTS.finalTex),
      ];
  }
}

/** Every stage in the plan, concatenated, for `paper-orchestra validate`. */
export function validateRun(
  workspace: string,
  plan: readonly StageId[],
  scope: Scope,
): Check[] {
  return plan.flatMap((stage) => validateStage(workspace, stage, scope));
}

export const validators = {
  artifactExists,
  schemaValid,
  outlineCoverage,
  citationIntegrity,
  literatureDedup,
  bibliographyProvenance,
  figureCoverage,
  templateCompatibility,
  noUnresolvedMarkers,
};
