/**
 * The fixed writing plan.
 *
 * The plan IS this tuple's order. Nothing may reorder or skip a stage; a test
 * asserts exact array equality so the vocabulary cannot drift silently. Every
 * per-stage attribute lives in its own `Record<StageId, ...>` lookup table
 * rather than in a stage object, so adding an attribute never touches the plan.
 */
export const STAGES = [
  "triage",
  "outline",
  "literature",
  "plotting",
  "section_writing",
  "refinement",
] as const;

export type StageId = (typeof STAGES)[number];

export function isStageId(value: string): value is StageId {
  return (STAGES as readonly string[]).includes(value);
}

/** Position of a stage in the plan, 1-indexed for display. */
export function stageNumber(id: StageId): number {
  return STAGES.indexOf(id) + 1;
}

/** The next stage in the plan, or null when `id` is the last. */
export function nextStage(id: StageId): StageId | null {
  const at = STAGES.indexOf(id);
  return at >= 0 && at < STAGES.length - 1 ? (STAGES[at + 1] as StageId) : null;
}

/**
 * Command markdown installed at `.opencode/commands/<name>.md`. The controller
 * reads the file from disk and inlines it into the prompt, so prompt text lives
 * outside the code and can be edited without a rebuild.
 */
export const COMMANDS: Record<StageId, string> = {
  triage: "0-po-triage",
  outline: "1-po-outline",
  literature: "2-po-literature",
  plotting: "3-po-plotting",
  section_writing: "4-po-section-writing",
  refinement: "5-po-refinement",
};

/** Human-readable stage titles for `status` output and checkpoint subjects. */
export const TITLES: Record<StageId, string> = {
  triage: "Triage",
  outline: "Outline",
  literature: "Literature review",
  plotting: "Plotting",
  section_writing: "Section writing",
  refinement: "Refinement",
};

/**
 * Per-stage wall-clock budget in milliseconds. Scaled by the run's
 * `timeout_multiplier` so a slow provider does not require patching source.
 */
export const TIMEOUTS_MS: Record<StageId, number> = {
  // Above outline's: triage may have to read across a whole directory before
  // it can write anything.
  triage: 15 * 60_000,
  outline: 10 * 60_000,
  literature: 30 * 60_000,
  plotting: 25 * 60_000,
  section_writing: 30 * 60_000,
  refinement: 35 * 60_000,
};

/**
 * Bounded remediation attempts per stage per process. Exceeding this marks the
 * stage failed and stops the run; recovery beyond that is operator-driven via
 * `paper-orchestra resume`, which is deliberate rather than an infinite retry.
 */
export const REMEDIATION_ATTEMPTS: Record<StageId, number> = {
  triage: 2,
  outline: 1,
  literature: 2,
  // Image generations are independent Codex turns, so a third attempt can
  // carry forward two rounds of accumulated visual feedback.
  plotting: 2,
  // Citation repairs need a deliberate pass over the controller-provided key
  // list, then a compile pass to confirm every citation actually resolves.
  section_writing: 2,
  refinement: 2,
};

/**
 * Stages that pause for human approval in collaborative mode. `plotting` is
 * absent on purpose: its output is verified mechanically by rendering, so a
 * human gate there buys nothing the validators do not already give.
 */
export const COLLABORATIVE_GATES: readonly StageId[] = [
  // Triage is the highest-leverage model call in the plan -- every later stage
  // reads its output -- so it is the one a human most wants to see.
  "triage",
  "outline",
  "literature",
  "section_writing",
  "refinement",
];
