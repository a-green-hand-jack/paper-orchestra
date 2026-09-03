import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACTS } from "./paths.js";
import { resumeStage } from "./state/store.js";
import type { RunState } from "./state/schema.js";

/** Stable result envelope consumed by other agents and automation systems. */
export function runResult(workspace: string, state: RunState): Record<string, unknown> {
  const absolute = resolve(workspace);
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
    exit_status: 0,
    workspace: absolute,
    run_id: state.run_id,
    run_state: state.status,
    current_stage: state.current_stage,
    next_stage: resumeStage(state),
    validation_failures: state.error ? [state.error] : [],
    artifacts: {
      latex: artifact(ARTIFACTS.finalTex),
      bibliography: artifact(ARTIFACTS.references),
      final_pdf: artifact(ARTIFACTS.finalPdf),
    },
  };
}
