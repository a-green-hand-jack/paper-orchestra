import { describe, expect, it } from "vitest";
import { buildStatus } from "../src/commands/status.js";
import { STAGES } from "../src/stages.js";
import { readRunState, updateStage } from "../src/state/store.js";
import { prepared } from "./fixtures.js";

describe("status report", () => {
  it("lists every stage in plan order with its number", async () => {
    const { workspace } = await prepared();
    const report = buildStatus(readRunState(workspace), 1);
    expect(report.stages.map((s) => s.id)).toEqual([...STAGES]);
    expect(report.stages.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("points at the stage a resume would run", async () => {
    const { workspace } = await prepared();
    updateStage(workspace, "triage", (s) => ({ ...s, status: "completed" }));
    updateStage(workspace, "outline", (s) => ({ ...s, status: "completed" }));
    expect(buildStatus(readRunState(workspace), 1).next_stage).toBe("literature");
  });

  it("says the default model is OpenCode's rather than inventing one", async () => {
    const { workspace } = await prepared();
    expect(buildStatus(readRunState(workspace), 1).default_model).toBe("opencode-default");
  });

  it("sums token usage across stages", async () => {
    const { workspace } = await prepared();
    const usage = {
      model_calls: 2,
      input_tokens: 1000,
      output_tokens: 200,
      reasoning_tokens: 0,
      cache_read_tokens: 5000,
      cache_write_tokens: 0,
      cost: 0.25,
      transcript_messages: 8,
    };
    updateStage(workspace, "outline", (s) => ({ ...s, usage }));
    updateStage(workspace, "literature", (s) => ({ ...s, usage }));
    const totals = buildStatus(readRunState(workspace), 1).totals;
    expect(totals.input_tokens).toBe(2000);
    expect(totals.cache_read_tokens).toBe(10000);
    expect(totals.cost).toBeCloseTo(0.5);
  });

  it("surfaces a stage error so status alone explains a stopped run", async () => {
    const { workspace } = await prepared();
    updateStage(workspace, "outline", (s) => ({
      ...s,
      status: "failed",
      error: "outline_coverage: expected section_plan to be non-empty",
    }));
    const stage = buildStatus(readRunState(workspace), 1).stages.find(
      (entry) => entry.id === "outline",
    );
    expect(stage?.status).toBe("failed");
    expect(stage?.error).toContain("outline_coverage");
  });
});
