import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRuntimeAssets, missingCommands } from "../src/assets.js";
import { approveRun } from "../src/controller.js";
import { COMMANDS } from "../src/stages.js";
import { readRunState, updateRunState } from "../src/state/store.js";
import { prepared } from "./fixtures.js";

describe("installRuntimeAssets", () => {
  it("installs opencode.json and the ported stage commands", async () => {
    const { workspace, state } = await prepared();
    const installed = installRuntimeAssets(workspace, state);
    expect(installed).toContain("opencode.json");
    expect(existsSync(join(workspace, ".opencode", "commands", `${COMMANDS.outline}.md`))).toBe(
      true,
    );
  });

  it("denies bash and the network tools, because the controller owns that work", async () => {
    // A stage's completion must be a fact about the filesystem, not a claim in
    // a transcript, so compilation and retrieval never run inside the session.
    const { workspace, state } = await prepared();
    installRuntimeAssets(workspace, state);
    const config = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
    expect(config.permission.bash).toBe("deny");
    expect(config.permission.webfetch).toBe("deny");
    expect(config.permission.websearch).toBe("deny");
    expect(config.permission.external_directory).toBe("deny");
  });

  it("allows editing, since edit covers write and patch in this schema", async () => {
    const { workspace, state } = await prepared();
    installRuntimeAssets(workspace, state);
    const config = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
    expect(config.permission.edit).toBe("allow");
    expect(config.permission).not.toHaveProperty("write");
  });

  it("denies question in autonomous mode so a headless run cannot hang", async () => {
    const { workspace, state } = await prepared({ mode: "autonomous" });
    installRuntimeAssets(workspace, state);
    const config = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
    expect(config.permission.question).toBe("deny");
  });

  it("allows question in collaborative mode, where a human is expected", async () => {
    const { workspace } = await prepared();
    const state = updateRunState(workspace, (c) => ({ ...c, mode: "collaborative" }));
    installRuntimeAssets(workspace, state);
    const config = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
    expect(config.permission.question).toBe("allow");
  });

  it("omits the model when the run defers to OpenCode's default", async () => {
    const { workspace, state } = await prepared();
    installRuntimeAssets(workspace, state);
    const config = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
    expect(config).not.toHaveProperty("model");
  });

  it("reports which stage commands are not yet ported", () => {
    // plotting's prompts live in paper_banana_utils.py rather than
    // methods/prompts/, so it is expected here until that stage lands.
    expect(missingCommands()).toEqual(["plotting"]);
  });
});

describe("approveRun", () => {
  it("releases a run waiting at a gate", async () => {
    const { workspace } = await prepared();
    updateRunState(workspace, (c) => ({ ...c, status: "gate_waiting" }));
    expect(approveRun(workspace).status).toBe("running");
    expect(readRunState(workspace).status).toBe("running");
  });

  it("refuses when the run is not waiting, saying what it is doing", async () => {
    const { workspace } = await prepared();
    expect(() => approveRun(workspace)).toThrow(/not waiting at a gate/);
  });

  it("refuses a workspace that does not exist", () => {
    expect(() => approveRun("/tmp/definitely-not-a-po-workspace")).toThrow(/no such workspace/);
  });
});

describe("supplied figures path", () => {
  it("publishes supplied figures and synthesizes captions without a model call", async () => {
    // The Python makes the user hand-write figures/info.json in the
    // non-plotting path, so a missing caption file surfaces as a confusing
    // downstream failure instead of being filled in here.
    const { workspace } = await prepared();
    const { validateStage } = await import("../src/validation.js");
    const { readRunState } = await import("../src/state/store.js");
    const { runSuppliedFiguresForTest } = await import("../src/controller.js");

    const published = runSuppliedFiguresForTest(workspace);
    expect(published).toBe(1);

    const state = readRunState(workspace);
    const checks = validateStage(workspace, "plotting", state.scope);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("falls back to the filename stem as a caption", async () => {
    const { workspace } = await prepared();
    const { runSuppliedFiguresForTest } = await import("../src/controller.js");
    runSuppliedFiguresForTest(workspace);
    const info = JSON.parse(
      readFileSync(join(workspace, ".brain", "manuscript", "figures", "info.json"), "utf8"),
    );
    expect(info[0].caption).toBe("overview");
  });
});
