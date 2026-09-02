import { z } from "zod";
import { STAGES, type StageId } from "../stages.js";
import { RUN_SCHEMA_VERSION, SESSION_SCHEMA_VERSION } from "../version.js";

/**
 * A provider/model pair plus optional variant. Recorded per stage because
 * OpenCode selects the model per prompt, so a run may legitimately use a
 * cheaper model for mechanical stages and a stronger one for drafting.
 */
export const ModelRefSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().nullable().default(null),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Cumulative token and cost figures, summed from assistant messages. */
export const UsageSchema = z.object({
  model_calls: z.number().int().nonnegative().default(0),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  reasoning_tokens: z.number().int().nonnegative().default(0),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  transcript_messages: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export const STAGE_STATUSES = [
  "pending",
  "running",
  "gate_waiting",
  "failed",
  "interrupted",
  "completed",
] as const;

export const StageStateSchema = z.object({
  status: z.enum(STAGE_STATUSES).default("pending"),
  /** Incremented on every entry, including a resume. Never reset. */
  attempts: z.number().int().nonnegative().default(0),
  /** Remediation prompts spent in the current process. */
  remediations: z.number().int().nonnegative().default(0),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  /** One line the stage records about what it did; empty means it did not. */
  notes: z.string().default(""),
  error: z.string().nullable().default(null),
  /** Session id for this stage. Each stage gets a fresh session. */
  session_id: z.string().nullable().default(null),
  model: ModelRefSchema.nullable().default(null),
  usage: UsageSchema.nullable().default(null),
});
export type StageState = z.infer<typeof StageStateSchema>;

/**
 * Every stage key is required, so a state file cannot be missing a stage. Built
 * from the STAGES tuple rather than written out, which keeps the schema and the
 * plan from drifting apart.
 */
export const StagesSchema = z.object(
  Object.fromEntries(STAGES.map((id) => [id, StageStateSchema])) as Record<
    StageId,
    typeof StageStateSchema
  >,
);

/**
 * The locked run configuration. Digested into `scope_digest` at `prepared` and
 * re-verified on resume, so a resume cannot quietly change what is being
 * written or which files count as input.
 */
export const ScopeSchema = z.object({
  plan: z.array(z.enum(STAGES)),
  use_plotting: z.boolean(),
  research_cutoff: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  idea_filename: z.string().min(1),
  experimental_log_filename: z.string().min(1),
  venue: z.string().min(1),
  network_policy: z.enum(["online", "offline"]),
  /**
   * Hard ceiling on literature retrieval calls. Locked into scope because it
   * changes which sources the manuscript could possibly cite, and each call
   * costs real money.
   */
  max_lkm_calls: z.number().int().nonnegative().default(40),
  /**
   * How many distinct sources the manuscript should cite.
   *
   * Replaces the Python's rule of citing 90% of whatever retrieval returned
   * (`literature_review_agent.py:492`). That rule is only defensible when
   * retrieval is precise: against LKM's general-science corpus it read as "put
   * 90% of the off-topic hits into the paper", and two measured runs cited 84
   * of 94 and 67 of 74 sources in ~2150 words -- roughly one citation per 25
   * words, which is citation stuffing rather than academic prose.
   *
   * A target rather than a ratio, so the number a reader sees is a property of
   * the paper and not of how large a retrieval budget the run happened to have.
   * The effective floor is `min(target, sources actually available)`.
   */
  target_citations: z.number().int().nonnegative().default(20),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const VersionsSchema = z.object({
  paper_orchestra: z.string().min(1),
  opencode: z.string().min(1),
  node: z.string().min(1),
});

export const RUN_STATUSES = [
  "preparing",
  "prepared",
  "running",
  "gate_waiting",
  "failed",
  "interrupted",
  "completed",
] as const;

export const RunStateSchema = z.object({
  schema_version: z.literal(RUN_SCHEMA_VERSION),
  run_id: z.string().min(1),
  run_branch: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  mode: z.enum(["autonomous", "collaborative"]),
  headless: z.boolean().default(false),
  stages: StagesSchema,
  current_stage: z.enum(STAGES).nullable().default(null),
  scope: ScopeSchema,
  scope_digest: z.string().length(64),
  /** Digest of `source/` at import. Mismatch on resume refuses the run. */
  source_digest: z.string().length(64),
  /** Digest of `template/` at import. */
  template_digest: z.string().length(64),
  /** Null means: let OpenCode's own configured default apply. */
  default_model: ModelRefSchema.nullable().default(null),
  stage_models: z.record(z.string(), ModelRefSchema).default({}),
  versions: VersionsSchema,
  timeout_multiplier: z.number().positive().default(1),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const SessionStateSchema = z.object({
  schema_version: z.literal(SESSION_SCHEMA_VERSION),
  server_url: z.string().min(1),
  /** Session id per stage; a fresh session per stage bounds transcript growth. */
  sessions: z.record(z.string(), z.string()).default({}),
  pid: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/** A single validator outcome. See `src/validation.ts` for why this is data. */
export const CheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type Check = z.infer<typeof CheckSchema>;
