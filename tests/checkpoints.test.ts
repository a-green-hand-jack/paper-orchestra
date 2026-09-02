import { execa } from "execa";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpoint, checkpointHistory, parseTrailers } from "../src/checkpoints.js";
import type { Check } from "../src/state/schema.js";
import { prepared } from "./fixtures.js";

async function log(workspace: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa("git", ["log", ...args], { cwd: workspace });
  return stdout;
}

describe("parseTrailers", () => {
  it("reads every PO trailer", () => {
    const parsed = parseTrailers(
      [
        "PO-Run: 20260902-abc",
        "PO-Stage: literature",
        "PO-Status: completed",
        "PO-Mode: autonomous",
        "PO-Session: ses_123",
        "PO-Model: openai/gpt-5.6-terra",
        "PO-Validation: 4 passed",
        "PO-Timestamp: 2026-09-02T10:00:00.000Z",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      run: "20260902-abc",
      stage: "literature",
      status: "completed",
      session: "ses_123",
      validation: "4 passed",
    });
  });

  it("tolerates a message with no trailers rather than throwing", () => {
    // `status` must still print history written by another version.
    expect(parseTrailers("just a subject")).toEqual({});
  });

  it("ignores unrelated trailer-shaped lines", () => {
    expect(parseTrailers("Co-Authored-By: someone\nPO-Stage: outline")).toEqual({
      stage: "outline",
    });
  });
});

describe("checkpoint", () => {
  it("takes a prepared checkpoint during workspace creation", async () => {
    const { workspace, checkpointSha } = await prepared();
    expect(checkpointSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await log(workspace, ["-1", "--format=%s"])).toBe("PO: prepare - prepared");
  });

  it("commits on the run branch, not on a default branch", async () => {
    const { workspace, state } = await prepared();
    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace,
    });
    expect(stdout).toBe(state.run_branch);
  });

  it("records a validation summary that names the failed checks", async () => {
    const { workspace, state } = await prepared();
    const checks: Check[] = [
      { name: "artifact_exists", passed: true, detail: "ok" },
      { name: "citation_integrity", passed: false, detail: "expected every cite key in the bib" },
    ];
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: "section_writing",
      status: "failed",
      mode: state.mode,
      checks,
    });
    const body = await log(workspace, ["-1", "--format=%b"]);
    expect(parseTrailers(body).validation).toBe("1/2 passed; failed: citation_integrity");
  });

  it("summarizes an all-passing run compactly", async () => {
    const { workspace, state } = await prepared();
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: "outline",
      status: "completed",
      mode: state.mode,
      checks: [{ name: "schema_valid", passed: true, detail: "ok" }],
    });
    expect(parseTrailers(await log(workspace, ["-1", "--format=%b"])).validation).toBe("1 passed");
  });

  it("commits even when the stage produced no diff", async () => {
    // --allow-empty is deliberate: a gate resolution or a validation pass over
    // already-correct artifacts still belongs in the timeline.
    const { workspace, state } = await prepared();
    const before = (await log(workspace, ["--oneline"])).split("\n").length;
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: "plotting",
      status: "completed",
      mode: state.mode,
    });
    const after = (await log(workspace, ["--oneline"])).split("\n").length;
    expect(after).toBe(before + 1);
  });

  it("captures artifacts a stage wrote", async () => {
    const { workspace, state } = await prepared();
    writeFileSync(join(workspace, ".brain", "raw", "outline.json"), '{"section_plan":[]}');
    await checkpoint({
      workspace,
      runId: state.run_id,
      stage: "outline",
      status: "completed",
      mode: state.mode,
    });
    const { stdout } = await execa("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: workspace,
    });
    expect(stdout).toContain(".brain/raw/outline.json");
  });

  it("builds a readable timeline newest-first", async () => {
    const { workspace, state } = await prepared();
    for (const stage of ["outline", "literature"] as const) {
      await checkpoint({
        workspace,
        runId: state.run_id,
        stage,
        status: "completed",
        mode: state.mode,
      });
    }
    const history = await checkpointHistory(workspace);
    expect(history.map((r) => r.stage)).toEqual(["literature", "outline", "prepare"]);
    expect(history[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns an empty history for a directory with no git repo", async () => {
    expect(await checkpointHistory("/tmp")).toEqual([]);
  });
});
