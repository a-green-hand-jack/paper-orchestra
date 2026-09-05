import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACTS } from "./paths.js";
import { resumeStage } from "./state/store.js";
import type { RunState } from "./state/schema.js";
import { manuscriptReadiness } from "./manuscript-review.js";
import { readBudget } from "./budget.js";

/** Stable result envelope consumed by other agents and automation systems. */
export function runResult(workspace: string, state: RunState): Record<string, unknown> {
  const absolute = resolve(workspace);
  const budget = readBudget(absolute);
  const artifact = (relative: string): string | null => {
    const path = resolve(absolute, relative);
    return existsSync(path) ? path : null;
  };
  return {
    type: "result",
    ok:
      state.status === "prepared" ||
      state.status === "completed" ||
      state.status === "gate_waiting",
    exit_status: state.status === "failed" || state.status === "interrupted" ? 1 : 0,
    plan_completed: state.status === "completed",
    submission_ready: state.status === "completed" && state.scope.plan.includes("refinement") &&
      manuscriptReadiness(absolute).passed,
    workspace: absolute,
    run_id: state.run_id,
    run_state: state.status,
    current_stage: state.current_stage,
    next_stage: resumeStage(state),
    budget: budget ? { limits: budget.limits, totals: budget.totals, stages: budget.stages,
      historical_usage_unknown: budget.historical_usage_unknown,
      cost_complete: !budget.historical_usage_unknown && budget.totals.unknown_cost_messages === 0 &&
        budget.totals.unreported_image_bills === 0 && budget.totals.unknown_usage_events === 0,
      cost_currency: "USD", cost_basis: "known reported model cost only; retrieval billing is separate" } : null,
    validation_failures:
      (state.status === "failed" || state.status === "interrupted") && state.error
        ? [state.error]
        : [],
    artifacts: {
      latex: artifact(ARTIFACTS.finalTex),
      bibliography: artifact(ARTIFACTS.references),
      final_pdf: artifact(ARTIFACTS.finalPdf),
      submission: artifact("submission"),
      review: artifact(".brain/manuscript/review.json"),
    },
  };
}
