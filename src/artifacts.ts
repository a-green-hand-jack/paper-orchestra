import { z } from "zod";

/**
 * Schemas for the artifacts PaperOrchestra's stages exchange.
 *
 * The Python reads every one of these with `.get()` and a default, so a
 * malformed outline silently produces a degraded paper rather than failing.
 * Validating them is the point of the rewrite, so these schemas are strict
 * about the fields consumers actually depend on and permissive about the rest
 * (`passthrough`), which lets a model add detail without breaking the run.
 */

/** Aspect ratios the plotting prompt offers. */
export const AspectRatioSchema = z.string().regex(/^\d+:\d+$/, "expected W:H, e.g. 16:9");

export const FigureRouteSchema = z.enum(["auto", "code", "text_to_image"]);

export const PlotSpecSchema = z
  .object({
    /**
     * Required and non-empty: it becomes a filename via `.replace()` in
     * `plotting_agent.py:258`, which throws on null.
     */
    figure_id: z.string().min(1, "figure_id is used as a filename and cannot be empty"),
    title: z.string().default(""),
    plot_type: z.enum(["plot", "diagram"]).default("plot"),
    /** Selected by the outline agent; `auto` is resolved deterministically by the controller. */
    render_route: FigureRouteSchema.default("auto"),
    /**
     * Workspace-relative paths to the files holding this figure's numbers.
     *
     * Was one of the three strings "idea.md", "experimental_log.md" or "both",
     * which named documents a triage stage synthesized rather than anything the
     * author wrote. The plotting stage is handed this value and told to read
     * it, so it has to be a path that exists.
     */
    data_source: z.array(z.string()).default([]),
    objective: z.string().default(""),
    /** Provider-ready visual brief for the text-to-image route. */
    generation_prompt: z.string().default(""),
    aspect_ratio: AspectRatioSchema.default("16:9"),
  })
  .passthrough();

function subsectionObject(value: unknown): unknown {
  // Models occasionally use the concise string form shown in prose outlines.
  // Normalize that harmless shorthand before the locked artifact is consumed by
  // query planning and the writing stages, so every downstream caller still
  // receives the object shape.
  return typeof value === "string" ? { subsection_title: value } : value;
}

export const RelatedWorkSubsectionSchema = z.preprocess(
  subsectionObject,
  z.object({
    subsection_title: z.string().min(1),
    methodology_cluster: z.string().default(""),
    sota_investigation_mission: z.string().default(""),
    limitation_hypothesis: z.string().default(""),
    limitation_search_queries: z.array(z.string()).default([]),
    bridge_to_our_method: z.string().default(""),
    /** Added by the literature stage; absent before it runs. */
    citation_candidates: z.array(z.string()).optional(),
  })
  .passthrough(),
);

export const SectionSubsectionSchema = z.preprocess(
  subsectionObject,
  z.object({
    subsection_title: z.string().min(1),
    content_bullets: z.array(z.string()).default([]),
    /**
     * Present before the literature stage, DELETED by it. The literature stage
     * replaces hints with resolved candidates
     * (`literature_review_agent.py:300-301`), so the two shapes differ and both
     * must parse.
     */
    citation_hints: z.array(z.string()).optional(),
    citation_candidates: z.array(z.string()).optional(),
  })
  .passthrough(),
);

export const SectionPlanEntrySchema = z
  .object({
    section_title: z.string().min(1),
    subsections: z.array(SectionSubsectionSchema).default([]),
  })
  .passthrough();

export const OutlineSchema = z
  .object({
    /**
     * How many distinct sources this paper's argument needs.
     *
     * Decided here because it is a property of the paper, not of the tool. A
     * fixed CLI default of 20 was wrong in both directions on measured tasks:
     * one graded paper's reference cites 22 and ours cited 29, costing
     * precision; another cites 62 and ours cited 47, costing recall. The stage
     * that has read the materials and written the section plan is the one that
     * can say how much support the argument takes.
     *
     * The controller bounds it rather than trusting it outright -- see
     * `citationFloor`. Zero means "no opinion", and the plan's own citation
     * hints then decide.
     */
    citation_target: z.number().int().nonnegative().default(0),
    plotting_plan: z.array(PlotSpecSchema).default([]),
    intro_related_work_plan: z
      .object({
        introduction_strategy: z
          .object({
            hook_hypothesis: z.string().default(""),
            problem_gap_hypothesis: z.string().default(""),
            search_directions: z.array(z.string()).default([]),
            citation_candidates: z.array(z.string()).optional(),
          })
          .passthrough()
          .default({}),
        related_work_strategy: z
          .object({
            overview: z.string().default(""),
            subsections: z.array(RelatedWorkSubsectionSchema).default([]),
          })
          .passthrough()
          .default({}),
      })
      .passthrough()
      .default({}),
    section_plan: z.array(SectionPlanEntrySchema).default([]),
  })
  .passthrough();
export type Outline = z.infer<typeof OutlineSchema>;

export const CitationRecordSchema = z
  .object({
    citation_key: z.string().min(1),
    title: z.string().min(1),
    authors: z.array(z.string()).default([]),
    venue: z.string().default(""),
    year: z.union([z.number().int(), z.string()]).nullable().default(null),
    abstract: z.string().default(""),
  })
  .passthrough();

/** `citation_map.json` is an object keyed by citation key. */
export const CitationMapSchema = z.record(z.string(), CitationRecordSchema);
export type CitationMap = z.infer<typeof CitationMapSchema>;

/**
 * A retrieval record, one per candidate the controller fetched. Not present in
 * the Python at all; it exists so every bibliography entry has an auditable
 * provider and provider id rather than only a title the model may have invented.
 */
export const CandidateSchema = z
  .object({
    citation_key: z.string().min(1),
    title: z.string().min(1),
    /**
     * Where this record came from. `bohrium_lkm` is the retrieval backend that
     * is implemented and `semantic_scholar`/`arxiv` are reserved, so adding one
     * does not need a schema migration.
     *
     * `supplied` is not a backend: it means the entry came from a bibliography
     * the author put under `source/`, so its provenance is the digest-locked
     * file rather than a query we paid for. It is recorded here for the reader
     * of the artifact; `bibliographyProvenance` decides which path a run is on
     * from `source/` itself, never from this field, because everything under
     * `.brain/` is writable by the agent being validated.
     */
    provider: z.enum(["bohrium_lkm", "semantic_scholar", "arxiv", "supplied"]),
    /** The provider's own identifier, so a record can be re-fetched and audited. */
    provider_id: z.string().min(1),
    /** When the record was obtained -- retrieved, or ingested from a supplied file. */
    retrieved_at: z.string().min(1),
    authors: z.array(z.string()).default([]),
    venue: z.string().default(""),
    year: z.union([z.number().int(), z.string()]).nullable().default(null),
    abstract: z.string().default(""),
    doi: z.string().default(""),
    /**
     * TF-IDF cosine against the paper's own topic profile (`src/relevance.ts`),
     * recorded so a bibliography can be audited for relevance after the fact
     * and not only for provenance.
     */
    relevance: z.number().min(0).max(1).default(0),
    /**
     * The outline citation hint this record answers, if any. A record with an
     * anchor was kept because the manuscript structurally needs it, which is
     * how `Segment Anything` and `PVT v2` survive a topical-similarity gate
     * their abstracts would otherwise fail.
     */
    anchor: z.string().nullable().default(null),
    /**
     * Which retrieval queries returned this record. Query-level provenance is
     * what makes retrieval precision measurable per query rather than only in
     * aggregate.
     */
    matched_queries: z.array(z.string()).default([]),
  })
  .passthrough();
export const CandidatesSchema = z.array(CandidateSchema);
export type Candidate = z.infer<typeof CandidateSchema>;

export const PlottingResultSchema = z
  .object({
    figure_id: z.string().min(1),
    title: z.string().default(""),
    task_name: z.enum(["plot", "diagram"]).default("plot"),
    render_route: z.enum(["code", "text_to_image"]).default("code"),
    description: z.string().default(""),
    caption: z.string().default(""),
    aspect_ratio: z.string().default("16:9"),
    critic_history: z
      .array(
        z
          .object({
            round: z.number().int().nonnegative(),
            passed: z.boolean().default(true),
            suggestions: z.string().default(""),
            revised_description: z.string().default(""),
          })
          .passthrough(),
      )
      .default([]),
    generation_provenance: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        prompt: z.string().min(1),
        parameters: z.record(z.unknown()).default({}),
      })
      .passthrough()
      .optional(),
    /** Absent when the figure failed to render. */
    image_path: z.string().optional(),
  })
  .passthrough();
export const PlottingResultsSchema = z.array(PlottingResultSchema);

/** `figures/info.json` — what the section writer reads to place figures. */
export const FigureInfoSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      caption: z.string().default(""),
    })
    .passthrough(),
);
export type FigureInfo = z.infer<typeof FigureInfoSchema>;

/**
 * The controller's LaTeX build report.
 *
 * Written by the controller, never by the agent, which is what lets
 * `latex_assembly` be a fact rather than a claim: the agent has no `bash` and
 * cannot run pdflatex at all.
 */
export const BuildReportSchema = z
  .object({
    ok: z.boolean(),
    source: z.string().min(1),
    pdf: z.string().nullable().default(null),
    pages: z.number().int().nullable().default(null),
    errors: z.array(z.string()).default([]),
    /**
     * Unresolved `[?]` groups in the RENDERED text. Independent of which
     * package emits which warning, so it catches a silently empty bibliography.
     */
    unresolved_citation_marks: z.number().int().nonnegative().default(0),
    /** Content overflowing its column, worst first. */
    overfull_boxes: z
      .array(z.object({ points: z.number(), lines: z.string() }))
      .default([]),
    built_at: z.string().min(1),
  })
  .passthrough();
export type BuildReport = z.infer<typeof BuildReportSchema>;

/**
 * `materials.json` — a map into the author's materials.
 *
 * NOT a rewrite of them. The stage that produces this used to synthesize two
 * fixed documents, `idea.md` and `experimental_log.md`, because the five
 * downstream prompts were ported from a Python pipeline that named those two
 * files in 25 places. That made the stage an adapter for legacy prompts rather
 * than a capability: an arbitrary input was compressed into a shape it may not
 * have, every later stage read only the compression, and whatever did not
 * survive it was invisible for the rest of the run.
 *
 * So the product is a map, and the stages read the materials themselves. Three
 * parts, each earning its place:
 *
 *  * `reading` says which files matter and what each one offers, so a stage
 *    with hundreds of files in front of it knows where to look. This is the
 *    part that makes a large input tractable, and it is the only reason a
 *    model runs here at all.
 *  * `facts` is the shared ledger of measured numbers, each carrying text
 *    copied verbatim from the file it came from. It replaces the prose digest
 *    for the one job the digest genuinely did -- keeping five stages from each
 *    inventing their own account of the experiments -- and does it better,
 *    because prose drifts and a quoted number does not.
 *  * `unresolved` records what the materials do not say, so a later stage
 *    reports its absence rather than inventing a plausible value.
 *
 * There is no fixed number of documents and no required length, because the
 * materials decide those. A theory paper has no experimental record; a dataset
 * paper has no methodology in the usual sense. The previous shape required at
 * least 400 bytes of each, which forced exactly the padding its own prompt
 * forbade.
 */
export const MaterialEntrySchema = z
  .object({
    /** Workspace-relative path to a file worth reading. */
    path: z.string().min(1),
    /** What this file offers, in the author's terms: "main benchmark results". */
    contributes: z.string().min(1),
  })
  .passthrough();

/**
 * A measured claim, with text copied verbatim from its source.
 *
 * The quote is what a byte floor can never buy. A model that invented a number
 * cannot produce a quote that is really in a file, and a substring test is a
 * fact about the filesystem rather than a second model's opinion.
 */
export const MaterialFactSchema = z
  .object({
    statement: z.string().min(1),
    /** The file the statement came from, workspace-relative. */
    source_path: z.string().min(1),
    /** Text copied verbatim from that file, which the validator re-reads. */
    quote: z.string().min(1),
  })
  .passthrough();

export const MaterialsMapSchema = z
  .object({
    /** How many files were looked at, so `reading` can be read as a selection. */
    materials_considered: z.number().int().nonnegative().default(0),
    /**
     * A few sentences of orientation. Deliberately unvalidated for length: the
     * moment a floor is put on it, it becomes the synthesized document this
     * artifact exists to remove.
     */
    summary: z.string().default(""),
    reading: z.array(MaterialEntrySchema).min(1),
    facts: z.array(MaterialFactSchema).default([]),
    /** Questions the materials could not answer, carried forward honestly. */
    unresolved: z.array(z.string()).default([]),
  })
  .passthrough();
export type MaterialsMap = z.infer<typeof MaterialsMapSchema>;
