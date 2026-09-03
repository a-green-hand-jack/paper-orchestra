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
    data_source: z.string().default("both"),
    objective: z.string().default(""),
    /** Provider-ready visual brief for the text-to-image route. */
    generation_prompt: z.string().default(""),
    aspect_ratio: AspectRatioSchema.default("16:9"),
  })
  .passthrough();

export const RelatedWorkSubsectionSchema = z
  .object({
    subsection_title: z.string().min(1),
    methodology_cluster: z.string().default(""),
    sota_investigation_mission: z.string().default(""),
    limitation_hypothesis: z.string().default(""),
    limitation_search_queries: z.array(z.string()).default([]),
    bridge_to_our_method: z.string().default(""),
    /** Added by the literature stage; absent before it runs. */
    citation_candidates: z.array(z.string()).optional(),
  })
  .passthrough();

export const SectionSubsectionSchema = z
  .object({
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
  .passthrough();

export const SectionPlanEntrySchema = z
  .object({
    section_title: z.string().min(1),
    subsections: z.array(SectionSubsectionSchema).default([]),
  })
  .passthrough();

export const OutlineSchema = z
  .object({
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
     * Which retrieval backend produced this record. `bohrium_lkm` is what is
     * implemented; the others are reserved so adding a backend does not need a
     * schema migration.
     */
    provider: z.enum(["bohrium_lkm", "semantic_scholar", "arxiv"]),
    /** The provider's own identifier, so a record can be re-fetched and audited. */
    provider_id: z.string().min(1),
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
