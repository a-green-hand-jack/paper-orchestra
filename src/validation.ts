import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import {
  BuildReportSchema,
  CandidatesSchema,
  CitationMapSchema,
  FigureInfoSchema,
  OutlineSchema,
  PlottingResultsSchema,
  TriageReportSchema,
} from "./artifacts.js";
import { assertInside, walkFiles } from "./files.js";
import {
  ANONYMITY_OPTIONS,
  bibKeys,
  citedKeys,
  documentClass,
  finalCopyCommands,
  includedGraphics,
  packageOptions,
  unresolvedMarkers,
  usedPackages,
} from "./latex.js";
import { suppliedBibliography } from "./bibliography.js";
import { ARTIFACTS, BRAIN_DIR, paths } from "./paths.js";
import { MIN_FIGURE_BYTES } from "./figures.js";
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
/**
 * Column overflow a reader would notice, in TeX points (~3.5mm).
 *
 * TeX reports anything above \hfuzz (0.1pt), and a few points of overflow is
 * both extremely common and invisible, so flagging every one would be noise.
 */
const COLUMN_OVERFLOW_PT = 10;

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
  // Subsection COUNT is deliberately not checked.
  //
  // The prompt states the structural preference itself ("If Subsection X.1 is
  // created, X.2 is mandatory... Omit subsections entirely if a section does
  // not require division"), and nothing downstream depends on it: the
  // literature stage's search-task collection and the section writer both
  // iterate whatever subsections exist, so zero, one or five all work.
  //
  // An earlier version required at least one subsection per section. That both
  // contradicted the prompt and cost a real remediation round on a live run,
  // pushing the model to invent subsections for Abstract and Conclusion. A
  // floor that fails a run should protect something; this one only enforced
  // taste.
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

/**
 * How many distinct sources the manuscript must cite.
 *
 * A target capped by availability, so a run whose retrieval legitimately found
 * only eight relevant papers is not failed for citing eight. Exported because
 * the controller substitutes the same number into the literature prompt: the
 * instruction the writer receives and the rule that judges it must be one
 * number, or the writer is being graded against something it was never told.
 */
export function citationFloor(available: number, scope: Scope): number {
  return Math.min(available, scope.target_citations);
}

/**
 * The manuscript must still cite what the literature stage went and found.
 *
 * Without this, the floor lives only in a prompt and only the drafting stage
 * ever hears it. Measured across two complete runs, `section_writing` obeyed
 * the instruction almost exactly (84 of 94, 67 of 74) and `refinement` then
 * discarded roughly three quarters of the citations (to 20, to 16) with no
 * check anywhere -- so the number a reader finally saw was whatever refinement
 * happened to leave. `citation_integrity` does not catch this: a manuscript
 * citing three of seventy-four sources passes it, because all three resolve.
 *
 * Checked at both drafting and refinement, since a floor enforced only at the
 * end is a floor discovered too late to repair cheaply.
 */
function citationFloorCheck(workspace: string, manuscriptRel: string, scope: Scope): Check {
  const name = "citation_floor";
  const tex = readIfExists(join(workspace, manuscriptRel));
  if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);

  // Counted from the bibliography, which is both what the message below claims
  // and what an external grader resolves citations against. It used to be
  // counted from `citation_map.json`, so this validator and
  // `citation_integrity` could report two different numbers for "available",
  // and neither matched the file the two of them were talking about. The counts
  // are identical on the retrieval path -- the controller writes both files from
  // one candidate list -- and only the origin-independent one is right for a
  // bibliography the author supplied.
  const bib = readIfExists(join(workspace, ARTIFACTS.references));
  if (bib === null) return fail(name, `expected ${ARTIFACTS.references} to exist`);

  const available = bibKeys(bib).length;
  const floor = citationFloor(available, scope);
  const cited = new Set(citedKeys(tex)).size;

  if (cited < floor) {
    return fail(
      name,
      `expected the manuscript to cite at least ${floor} distinct sources; it cites ` +
        `${cited}. ${available} sources are available in references.bib. Add ` +
        `citations from the existing bibliography where they genuinely support a claim -- ` +
        "do not invent keys, and do not pad a single sentence with unrelated references.",
    );
  }
  return pass(name, `${cited} distinct sources cited (floor ${floor} of ${available} available)`);
}

/**
 * Every generated figure is a real, non-trivial image on disk.
 *
 * `figure_coverage` checks that a planned figure has SOME image_path recorded;
 * this checks the file that path names is actually a figure. The failure it
 * exists for is a matplotlib script that runs cleanly, saves, and produces an
 * empty canvas -- which happens whenever the model calls `plt.close()` or
 * `plt.clf()` before saving. That file exists, satisfies coverage, and prints
 * as a blank rectangle in the manuscript.
 *
 * Replaces the Python's critic loop, which ran up to 3 rounds terminated by
 * the model emitting the literal string "No changes needed."
 * (`plotting_agent.py:139`) -- making the model's own text the completion
 * signal, which is exactly what the controller contract refuses.
 */
function figureRender(workspace: string, scope: Scope): Check {
  const name = "figure_render";
  if (!scope.use_plotting) {
    return pass(name, "plotting is off; supplied figures are used as-is");
  }

  const parsed = parseArtifact(
    workspace,
    ARTIFACTS.plottingResults,
    PlottingResultsSchema,
    name,
  );
  if (!parsed.ok) return parsed.check;

  const problems: string[] = [];
  for (const result of parsed.value) {
    if (!result.image_path) continue; // figure_coverage owns the missing case
    if (!result.generation_provenance) {
      problems.push(`${result.figure_id}: generation provenance is missing`);
    }
    const lastReview = result.critic_history[result.critic_history.length - 1];
    if (!lastReview) {
      problems.push(`${result.figure_id}: rendered output was not visually reviewed`);
    } else if (!lastReview.passed) {
      problems.push(`${result.figure_id}: final visual review did not pass`);
    }
    if (result.render_route === "code" && extname(result.image_path).toLowerCase() !== ".pdf") {
      problems.push(`${result.figure_id}: code-generation output must be PDF`);
    }
    const abs = join(workspace, BRAIN_DIR, "manuscript", result.image_path);
    if (!existsSync(abs)) {
      problems.push(`${result.figure_id}: ${result.image_path} does not exist`);
      continue;
    }
    const bytes = statSync(abs).size;
    if (bytes < MIN_FIGURE_BYTES) {
      problems.push(
        `${result.figure_id}: ${result.image_path} is only ${bytes} bytes, so it is an ` +
          "empty canvas rather than a figure",
      );
    }
  }

  if (problems.length > 0) {
    return fail(
      name,
      `expected every generated figure to have auditable generation, a passing visual review, ` +
        `and a real output image; ${problems.join("; ")}.`,
    );
  }
  return pass(name, `${parsed.value.length} generated figure(s) render to real images`);
}

/**
 * No two bibliography entries may describe the same paper.
 *
 * This targets OUR retrieval: two providers returning one paper under different
 * ids is a defect in the merge, and a manuscript citing it twice reads as
 * padding. It does not target the author's own library.
 *
 * On a supplied bibliography the duplicates are an editorial fact about a file
 * we were told to use as-is. `pwb-0001`'s 114 real entries contain seven such
 * pairs -- a short hand-written key beside a verbose generated one for the same
 * paper (`llava` / `liu2023visualinstructiontuning`) -- which is simply what a
 * bibliography merged from several tools looks like. Failing the stage for it
 * would reject the file for something BibTeX itself accepts, and something the
 * external grader does not care about. So the duplicates are reported, loudly
 * enough to be visible in the checkpoint, and the stage proceeds.
 */
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

  const suppliedRel = suppliedBibliography(workspace);
  if (suppliedRel) {
    if (collisions.length === 0) {
      return pass(name, `${byTitle.size} distinct references in the supplied bibliography`);
    }
    return pass(
      name,
      `${byTitle.size} distinct papers across ${Object.keys(parsed.value).length} entries; ` +
        `${suppliedRel} lists ${collisions.length} paper(s) more than once ` +
        `(${collisions.map((keys) => keys.join("/")).join("; ")}). Supplied as-is; ` +
        "cite one key per paper.",
    );
  }

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
 * Every bibliography entry must trace to something outside the model's reach.
 *
 * Absent from the Python entirely. Because the controller -- never the model --
 * writes both sides of this comparison, it is mechanically checkable: an entry
 * with nothing backing it was added by the model, which is the fabrication case.
 *
 * There are two origins and the evidence differs, so the check does too.
 *
 * The branch is decided by `suppliedBibliography`, which asks whether
 * `source/references.bib` exists. That is deliberate: `source/` is digest-locked
 * and read-only, whereas everything under `.brain/` is writable by the agent
 * being validated (#28). Reading `provider: "supplied"` out of `candidates.json`
 * would have let a model turn this check off by editing one string.
 */
function bibliographyProvenance(workspace: string): Check {
  const name = "bibliography_provenance";
  const bib = readIfExists(join(workspace, ARTIFACTS.references));
  if (bib === null) return fail(name, `expected ${ARTIFACTS.references} to exist`);

  const suppliedRel = suppliedBibliography(workspace);
  if (suppliedRel) {
    // Stronger than the retrieval path, not weaker: the reference set is a
    // digest-locked file under `source/`, so `verifyLocks` would already have
    // refused the run if it had changed since prepare. Comparing against
    // `candidates.json` here instead would be circular -- the controller
    // derives that file FROM this one.
    const supplied = readIfExists(join(workspace, suppliedRel));
    if (supplied === null) {
      return fail(name, `expected the supplied bibliography ${suppliedRel} to be readable`);
    }
    const authored = new Set(bibKeys(supplied));
    const invented = bibKeys(bib).filter((key) => !authored.has(key));
    if (invented.length > 0) {
      return fail(
        name,
        `expected every entry in ${ARTIFACTS.references} to come from the supplied ` +
          `bibliography ${suppliedRel}; these do not appear in it: ${invented.join(", ")}. ` +
          "Cite only from the supplied bibliography; do not add entries to it.",
      );
    }
    return pass(
      name,
      `${authored.size} entries, each traced to the digest-locked ${suppliedRel}`,
    );
  }

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

  // Support files are counted for the report, not required. A template that
  // relies on the TeX installation instead of shipping its own style is
  // ordinary -- `\documentclass{article}` with standard packages carries none
  // at all, and 7 of the 273 inputs measured for template discovery ship no
  // .sty/.bst/.cls anywhere. Requiring one failed those runs at
  // `section_writing`, after most of the model spend, for something that is not
  // a defect.
  //
  // Whether the dependencies actually resolve is proved by `latex_assembly`,
  // which runs a real four-pass build: a template missing a class file it needs
  // fails there with TeX's own diagnosis, which is stronger evidence than a
  // count of files in a directory.
  const support = walkFiles(p.template).filter((rel) =>
    [".sty", ".bst", ".cls"].includes(extname(rel)),
  );

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

/**
 * The manuscript must not weaken the anonymity its template configured.
 *
 * Anonymity is the template's job, not the model's: CVPR renders "Anonymous
 * CVPR submission" only under `\\usepackage[review]{cvpr}` (`cvpr.sty:59`,
 * `:290-297`), and ICLR anonymizes by default until `\iclrfinalcopy` is called
 * (`iclr2025_conference.sty:28-31`). Both are invisible to
 * `templateCompatibility`, which compares only the `\documentclass` name and
 * discards its option list.
 *
 * The check compares against `template/template.tex` rather than a per-venue
 * table, because a user-supplied template directory carries no metadata to
 * consult -- the benchmark author kits, for instance, ship no
 * `template-metadata.json` at all. Comparing states the invariant directly: an
 * anonymity option the template passed has to survive, and a camera-ready
 * switch the template did not use must not appear. A template with no
 * anonymity mechanism (Nature Portfolio is single-anonymous, so real names are
 * correct there) passes without assertion.
 */
function anonymityPreserved(workspace: string, manuscriptRel: string): Check {
  const name = "anonymity_preserved";
  const p = paths(workspace);
  const tex = readIfExists(join(workspace, manuscriptRel));
  if (tex === null) return fail(name, `expected ${manuscriptRel} to exist`);

  const templateMain = readIfExists(join(p.template, "template.tex"));
  if (templateMain === null) {
    return pass(name, "no template.tex to compare against, so no configured anonymity mode");
  }

  for (const pkg of usedPackages(templateMain)) {
    const required = (packageOptions(templateMain, pkg) ?? []).filter((option) =>
      ANONYMITY_OPTIONS.includes(option),
    );
    if (required.length === 0) continue;

    const actual = packageOptions(tex, pkg);
    if (actual === null) {
      return fail(
        name,
        `expected the manuscript to load the venue style as ` +
          `\\usepackage[${required.join(",")}]{${pkg}}, which is what renders the ` +
          `anonymous title block; the manuscript does not load ${pkg} at all`,
      );
    }
    const dropped = required.filter((option) => !actual.includes(option));
    if (dropped.length > 0) {
      return fail(
        name,
        `expected \\usepackage{${pkg}} to keep the option(s) ${dropped.join(", ")} that the ` +
          `template passes; without them the style file prints an author block instead of the ` +
          `anonymous one. Restore \\usepackage[${required.join(",")}]{${pkg}}`,
      );
    }
  }

  const templateSwitches = finalCopyCommands(templateMain);
  const added = finalCopyCommands(tex).filter((command) => !templateSwitches.includes(command));
  if (added.length > 0) {
    return fail(
      name,
      `expected the manuscript not to call ${added.join(", ")}; the template does not, and that ` +
        `switch turns off the anonymous title block. Remove it`,
    );
  }

  return pass(name, "anonymity mode matches the template");
}

function workspaceVenue(workspace: string): string {
  return basename(workspace);
}

/**
 * The manuscript must compile.
 *
 * In the Python a compile failure merely `continue`s the reflection loop
 * (content_refinement_agent.py:322-324), so a paper that never produced a PDF
 * could still end a run reported as success. Here the controller compiles and
 * records the result, and the extracted LaTeX errors become the remediation
 * instruction verbatim.
 */
function latexAssembly(workspace: string): Check {
  const name = "latex_assembly";
  if (!existsSync(join(workspace, ARTIFACTS.buildReport))) {
    return fail(
      name,
      "expected the controller to have compiled the manuscript; no build report was found",
    );
  }
  const parsed = parseArtifact(workspace, ARTIFACTS.buildReport, BuildReportSchema, name);
  if (!parsed.ok) return parsed.check;
  const report = parsed.value;

  if (!report.ok) {
    const shown = report.errors.slice(0, 8);
    return fail(
      name,
      `expected ${report.source} to compile with pdflatex; it did not. Fix these LaTeX ` +
        `errors: ${shown.join(" | ")}${report.errors.length > shown.length ? " ..." : ""}`,
    );
  }

  // Checked before the log, because it does not depend on knowing which
  // package emits which warning. A manuscript whose citations resolved contains
  // no `[?]` groups in its rendered text.
  if (report.unresolved_citation_marks > 0) {
    return fail(
      name,
      `expected the compiled PDF to render every citation, but ${report.unresolved_citation_marks} ` +
        `appear as "[?]". The bibliography did not resolve, so the manuscript is not ` +
        `submission-ready even though it compiled.`,
    );
  }

  const undefinedCitations = report.errors.filter((line) =>
    /didn't find a database entry/.test(line),
  );
  if (undefinedCitations.length > 0) {
    return fail(
      name,
      `expected every citation to resolve at compile time; these do not: ` +
        `${undefinedCitations.slice(0, 6).join(" | ")}. Cite a key that exists in ` +
        `references.bib.`,
    );
  }

  // Content wider than its column is what produces visible layout damage: a
  // table 41pt too wide for a CVPR column spilled across the gutter and landed
  // on top of the References heading on a real run. Small overfulls are endemic
  // in real papers and invisible in print, so only a spill a reader would
  // actually see is a defect -- a floor that fails a run should protect
  // something.
  const spills = report.overfull_boxes.filter((box) => box.points >= COLUMN_OVERFLOW_PT);
  if (spills.length > 0) {
    const worst = spills[0] as { points: number; lines: string };
    return fail(
      name,
      `expected all content to fit its column, but ${spills.length} block(s) overflow; ` +
        `the worst is ${Math.round(worst.points)}pt too wide at line(s) ${worst.lines}. ` +
        `In a two-column layout an overflowing table or figure prints on top of the ` +
        `neighbouring column. Either span both columns with the starred float ` +
        `environment (table*/figure*), or reduce the content: fewer columns, ` +
        `abbreviated headers, or a smaller font via \\small or \\resizebox.`,
    );
  }

  return pass(name, `${report.source} compiled to ${report.pages ?? "?"} page(s)`);
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

/** Where a triage-cited path is allowed to live. */
function triageReadableRoots(workspace: string): string[] {
  const p = paths(workspace);
  return [p.source, p.brainInput];
}

/**
 * Every path triage cites must exist among the materials.
 *
 * Modelled on `bibliographyProvenance`: the controller knows what was imported,
 * so a reference it cannot resolve was invented. Without this, `sources` and
 * `claims` could name plausible-sounding files that were never there.
 */
function triageProvenance(workspace: string): Check {
  const name = "triage_provenance";
  const parsed = parseArtifact(workspace, ARTIFACTS.triageReport, TriageReportSchema, name);
  if (!parsed.ok) return parsed.check;
  const report = parsed.value;

  const roots = triageReadableRoots(workspace);
  const cited = [
    ...report.sources.map((entry) => entry.path),
    ...report.claims.map((claim) => claim.source_path),
  ];
  const unresolved: string[] = [];
  for (const rel of [...new Set(cited)]) {
    let abs: string;
    try {
      abs = assertInside(workspace, rel);
    } catch {
      unresolved.push(`${rel} (escapes the workspace)`);
      continue;
    }
    if (!existsSync(abs)) {
      unresolved.push(`${rel} (does not exist)`);
      continue;
    }
    if (!roots.some((root) => abs === root || abs.startsWith(`${root}/`))) {
      unresolved.push(`${rel} (outside source/ and .brain/input/)`);
    }
  }

  if (unresolved.length > 0) {
    return fail(
      name,
      `expected every path in triage.json to name a file among the imported materials; ` +
        `these do not: ${unresolved.slice(0, 8).join(", ")}. Cite only files you actually read.`,
    );
  }
  return pass(name, `${cited.length} cited path(s), all present`);
}

/** Whitespace-normalized, so a re-wrapped quote still matches its source. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every claim's quote must really appear in the file it names.
 *
 * This is the answer to "how is a bad synthesis caught", and it is why a byte
 * floor is not: `{}` clears a floor, and a fluent invented paragraph clears any
 * length check. A model that fabricated a number cannot produce a quote that is
 * actually in a file, and a substring test is a fact about the filesystem
 * rather than a second model's opinion -- the same standard the rest of the
 * validators hold to.
 */
function triageGrounding(workspace: string): Check {
  const name = "triage_grounding";
  const parsed = parseArtifact(workspace, ARTIFACTS.triageReport, TriageReportSchema, name);
  if (!parsed.ok) return parsed.check;
  const report = parsed.value;

  if (report.mode === "supplied") {
    return pass(name, "documents were supplied, so there is nothing to ground");
  }
  if (report.claims.length === 0) {
    return fail(
      name,
      "expected triage.json to carry at least one claim quoting the material it came from, " +
        "found none. Each claim needs a statement, the file it came from, and text copied " +
        "verbatim from that file.",
    );
  }

  const ungrounded: string[] = [];
  for (const claim of report.claims) {
    let abs: string;
    try {
      abs = assertInside(workspace, claim.source_path);
    } catch {
      ungrounded.push(`${claim.source_path} (escapes the workspace)`);
      continue;
    }
    const body = readIfExists(abs);
    if (body === null) {
      ungrounded.push(`${claim.source_path} (does not exist)`);
      continue;
    }
    if (!flatten(body).includes(flatten(claim.quote))) {
      ungrounded.push(`"${claim.quote.slice(0, 60)}" is not in ${claim.source_path}`);
    }
  }

  if (ungrounded.length > 0) {
    return fail(
      name,
      `expected every claim's quote to appear verbatim in the file it names; ` +
        `${ungrounded.slice(0, 5).join("; ")}. Copy the text rather than paraphrasing it.`,
    );
  }
  return pass(name, `${report.claims.length} claim(s) grounded in the materials`);
}

/**
 * The synthesized documents must have the shape the later stages assume.
 *
 * A modest structural floor, in the spirit of `outlineCoverage`: the outline
 * stage reads headed sections out of the idea document, and the writer quotes
 * numbers out of the log, so an idea with no structure or a log with no figures
 * at all is a synthesis that will fail later and more expensively. Grounding
 * does the substantive work; this only rules out the empty shell.
 */
function triageCoverage(workspace: string, minHeadings = 2): Check {
  const name = "triage_coverage";
  const parsed = parseArtifact(workspace, ARTIFACTS.triageReport, TriageReportSchema, name);
  if (!parsed.ok) return parsed.check;
  if (parsed.value.mode === "supplied") {
    return pass(name, "documents were supplied by the author");
  }

  const idea = readIfExists(join(workspace, ARTIFACTS.synthesizedIdea));
  const log = readIfExists(join(workspace, ARTIFACTS.synthesizedLog));
  if (idea === null) return fail(name, `expected ${ARTIFACTS.synthesizedIdea} to exist`);
  if (log === null) return fail(name, `expected ${ARTIFACTS.synthesizedLog} to exist`);

  const headings = (idea.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (headings < minHeadings) {
    return fail(
      name,
      `expected the synthesized idea to carry at least ${minHeadings} markdown headings ` +
        `(problem, approach, contributions), found ${headings}`,
    );
  }
  if (!/\d/.test(log)) {
    return fail(
      name,
      "expected the synthesized experimental log to report at least one measured number; " +
        "it contains no digits. If the materials hold no results, say so in `unresolved` " +
        "rather than writing a log without them.",
    );
  }
  return pass(name, `${headings} headings in the idea, numbers present in the log`);
}

/**
 * Validate one stage's artifacts.
 *
 * A single function branching on stage rather than a registry, so the full set
 * of checks for a stage is readable in one place.
 */
export function validateStage(workspace: string, stage: StageId, scope: Scope): Check[] {
  switch (stage) {
    case "triage":
      return [
        artifactExists(workspace, ARTIFACTS.synthesizedIdea, 400),
        artifactExists(workspace, ARTIFACTS.synthesizedLog, 400),
        schemaValid(workspace, ARTIFACTS.triageReport, TriageReportSchema),
        triageProvenance(workspace),
        triageGrounding(workspace),
        triageCoverage(workspace),
      ];

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
        artifactExists(workspace, ARTIFACTS.updatedTemplate, 256),
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
        figureRender(workspace, scope),
        figureCoverage(workspace, scope, null),
      ];

    case "section_writing":
      return [
        artifactExists(workspace, ARTIFACTS.rawDraft, 512),
        citationIntegrity(workspace, ARTIFACTS.rawDraft),
        citationFloorCheck(workspace, ARTIFACTS.rawDraft, scope),
        figureCoverage(workspace, scope, ARTIFACTS.rawDraft),
        templateCompatibility(workspace, ARTIFACTS.rawDraft),
        anonymityPreserved(workspace, ARTIFACTS.rawDraft),
        // Compile here rather than only at refinement: a draft that cannot
        // build is far cheaper to fix now than after a refinement pass has
        // rewritten it.
        latexAssembly(workspace),
      ];

    case "refinement":
      return [
        artifactExists(workspace, ARTIFACTS.finalTex, 512),
        artifactExists(workspace, ARTIFACTS.finalPdf, 1024),
        latexAssembly(workspace),
        citationIntegrity(workspace, ARTIFACTS.finalTex),
        citationFloorCheck(workspace, ARTIFACTS.finalTex, scope),
        figureCoverage(workspace, scope, ARTIFACTS.finalTex),
        templateCompatibility(workspace, ARTIFACTS.finalTex),
        anonymityPreserved(workspace, ARTIFACTS.finalTex),
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
  latexAssembly,
  artifactExists,
  schemaValid,
  outlineCoverage,
  citationIntegrity,
  citationFloorCheck,
  literatureDedup,
  bibliographyProvenance,
  figureCoverage,
  figureRender,
  templateCompatibility,
  anonymityPreserved,
  triageProvenance,
  triageGrounding,
  triageCoverage,
  noUnresolvedMarkers,
};
