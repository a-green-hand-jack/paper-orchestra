import { describe, expect, it } from "vitest";
import { runResult } from "../src/automation.js";
import { readRunState, updateRunState } from "../src/state/store.js";
import { prepared } from "./fixtures.js";

describe("agent-callable CLI result", () => {
  it("exposes workspace, state, next stage, validation failures, and artifact paths", async () => {
    const { workspace } = await prepared();
    const state = updateRunState(workspace, (current) => ({
      ...current,
      status: "gate_waiting",
      current_stage: "outline",
    }));
    const result = runResult(workspace, state);
    expect(result).toMatchObject({
      type: "result",
      ok: true,
      exit_status: 0,
      workspace,
      run_id: readRunState(workspace).run_id,
      run_state: "gate_waiting",
      current_stage: "outline",
      next_stage: "outline",
      validation_failures: [],
      artifacts: { latex: null, final_pdf: null },
    });
  });

  it("does not report a stale failure after a recovered run completes", async () => {
    const { workspace } = await prepared();
    const state = updateRunState(workspace, (current) => ({
      ...current,
      status: "completed",
      current_stage: null,
      error: "an earlier plotting attempt failed",
    }));

    expect(runResult(workspace, state)).toMatchObject({
      ok: true,
      run_state: "completed",
      validation_failures: [],
    });
  });
});
