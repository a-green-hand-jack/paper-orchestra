import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../src/files.js";
import { paths } from "../src/paths.js";
import { STAGES } from "../src/stages.js";
import { RunStateSchema } from "../src/state/schema.js";
import {
  StateError,
  completedStages,
  readRunState,
  resumeStage,
  updateStage,
  verifyLocks,
  writeRunState,
} from "../src/state/store.js";
import { prepared, tamper } from "./fixtures.js";

describe("prepared workspace", () => {
  it("creates the layout issue #1 specifies", async () => {
    const { workspace } = await prepared();
    const p = paths(workspace);
    for (const dir of [
      p.brainInput,
      p.brainRaw,
      p.brainManuscript,
      p.brainTmp,
      p.source,
      p.template,
      p.runDir,
      p.checkpoints,
      p.logs,
    ]) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it("records validated state with every stage pending", async () => {
    const { workspace } = await prepared();
    const state = readRunState(workspace);
    expect(state.status).toBe("prepared");
    expect(Object.keys(state.stages).sort()).toEqual([...STAGES].sort());
    for (const id of STAGES) expect(state.stages[id].status).toBe("pending");
  });

  it("locks the plan and the scope digest", async () => {
    const { workspace } = await prepared();
    const state = readRunState(workspace);
    expect(state.scope.plan).toEqual([...STAGES]);
    expect(state.scope_digest).toHaveLength(64);
    expect(() => verifyLocks(workspace, state)).not.toThrow();
  });

  it("normalizes markdown material into .brain/input", async () => {
    const { workspace, brainInputs } = await prepared();
    expect(brainInputs.some((p) => p.endsWith("idea_sparse.md"))).toBe(true);
    expect(readFileSync(join(workspace, ".brain", "input", "idea_sparse.md"), "utf8")).toContain(
      "temporal adapter",
    );
  });

  it("refuses to prepare over an existing run", async () => {
    const { workspace, options } = await prepared();
    await expect(
      (await import("../src/commands/prepare.js")).prepareWorkspace({ ...options, workspace }),
    ).rejects.toThrow(/already holds a run/);
  });
});

describe("locks", () => {
  it("refuses resume after source material is edited", async () => {
    // This is the guarantee that a manuscript's provenance still matches its
    // checkpoints: silently accepting a changed input would break it.
    const { workspace } = await prepared();
    tamper(join(workspace, "source", "idea_sparse.md"), "# Different idea\n");
    expect(() => verifyLocks(workspace, readRunState(workspace))).toThrow(
      /source\/ changed since import/,
    );
  });

  it("refuses resume after the template is edited", async () => {
    const { workspace } = await prepared();
    tamper(join(workspace, "template", "template.tex"), "\\documentclass{book}\n");
    expect(() => verifyLocks(workspace, readRunState(workspace))).toThrow(
      /template\/ changed since import/,
    );
  });

  it("refuses resume when run.json's own scope was hand-edited", async () => {
    const { workspace } = await prepared();
    const state = readRunState(workspace);
    writeJsonAtomic(paths(workspace).runState, {
      ...state,
      scope: { ...state.scope, use_plotting: !state.scope.use_plotting },
    });
    expect(() => verifyLocks(workspace, readRunState(workspace))).toThrow(/scope digest mismatch/);
  });

  it("names the run and says to start a new one", async () => {
    const { workspace } = await prepared();
    tamper(join(workspace, "source", "idea_sparse.md"), "changed");
    const state = readRunState(workspace);
    expect(() => verifyLocks(workspace, state)).toThrow(new RegExp(state.run_id));
    expect(() => verifyLocks(workspace, state)).toThrow(/Start a new run/);
  });
});

describe("resume selection", () => {
  it("starts at the first stage of a fresh run", async () => {
    const { workspace } = await prepared();
    expect(resumeStage(readRunState(workspace))).toBe("outline");
  });

  it("skips completed stages and stops at the first unfinished one", async () => {
    const { workspace } = await prepared();
    updateStage(workspace, "outline", (s) => ({ ...s, status: "completed" }));
    updateStage(workspace, "literature", (s) => ({ ...s, status: "completed" }));
    expect(resumeStage(readRunState(workspace))).toBe("plotting");
  });

  it("resumes a failed stage rather than stepping past it", async () => {
    const { workspace } = await prepared();
    updateStage(workspace, "outline", (s) => ({ ...s, status: "completed" }));
    updateStage(workspace, "literature", (s) => ({ ...s, status: "failed" }));
    expect(resumeStage(readRunState(workspace))).toBe("literature");
  });

  it("returns null once the whole plan is complete", async () => {
    const { workspace } = await prepared();
    for (const id of STAGES) updateStage(workspace, id, (s) => ({ ...s, status: "completed" }));
    const state = readRunState(workspace);
    expect(resumeStage(state)).toBeNull();
    expect(completedStages(state)).toEqual([...STAGES]);
  });
});

describe("state integrity", () => {
  it("rejects an invalid state file instead of running on it", async () => {
    const { workspace } = await prepared();
    writeJsonAtomic(paths(workspace).runState, { schema_version: "po-run-v1" });
    expect(() => readRunState(workspace)).toThrow(StateError);
  });

  it("rejects an unknown stage status", async () => {
    const { workspace } = await prepared();
    const state = readRunState(workspace);
    expect(() =>
      writeRunState(workspace, {
        ...state,
        stages: { ...state.stages, outline: { ...state.stages.outline, status: "blocked" as never } },
      }),
    ).toThrow();
  });

  it("refuses a missing run state with an actionable message", () => {
    expect(() => readRunState("/tmp/definitely-not-a-po-workspace")).toThrow(
      /is this a paper-orchestra workspace/,
    );
  });

  it("keeps attempts monotonic across updates", async () => {
    const { workspace } = await prepared();
    updateStage(workspace, "outline", (s) => ({ ...s, attempts: s.attempts + 1 }));
    updateStage(workspace, "outline", (s) => ({ ...s, attempts: s.attempts + 1 }));
    expect(readRunState(workspace).stages.outline.attempts).toBe(2);
  });

  it("round-trips through the schema unchanged", async () => {
    const { workspace } = await prepared();
    const state = readRunState(workspace);
    expect(RunStateSchema.parse(state)).toEqual(state);
  });
});
