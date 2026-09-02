import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeJsonAtomic } from "./files.js";
import { paths } from "./paths.js";
import { COMMANDS, STAGES } from "./stages.js";
import type { RunState } from "./state/schema.js";

/**
 * Locate the packaged `assets/` directory.
 *
 * Resolved relative to this module rather than the working directory so the CLI
 * works when installed globally, which is how it is meant to be used.
 */
function assetRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", "assets"),
    resolve(here, "..", "..", "assets"),
  ]) {
    if (existsSync(join(candidate, "commands"))) return candidate;
  }
  throw new Error(`cannot locate packaged assets/ from ${here}`);
}

/**
 * Permissions for the run.
 *
 * Default-deny. The agent writes artifacts and reads inputs; everything
 * mechanical -- LaTeX compilation, figure scripts, literature retrieval -- is
 * the controller's job, so `bash` and the network tools stay denied. That is
 * what makes a stage's completion a fact about the filesystem rather than a
 * claim in a transcript.
 *
 * Note the schema has no `write` or `patch` key: `edit` covers both.
 */
function permissions(mode: RunState["mode"]): Record<string, unknown> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "allow",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    external_directory: "deny",
    // A question in autonomous mode would hang a headless run with nobody to
    // answer it; collaborative runs pause at gates instead, which is where a
    // human is actually expected.
    question: mode === "collaborative" ? "allow" : "deny",
    todowrite: "allow",
  };
}

/**
 * Install `.opencode/` into the workspace: config plus the stage commands.
 *
 * Commands are copied rather than embedded so a run's prompts are inspectable
 * and editable on disk, and so a checkpoint records exactly which prompt text
 * produced a given artifact.
 */
export function installRuntimeAssets(workspace: string, state: RunState): string[] {
  const p = paths(workspace);
  const root = assetRoot();
  const commandsOut = join(p.opencode, "commands");
  ensureDir(commandsOut);

  const installed: string[] = [];
  const available = new Set(readdirSync(join(root, "commands")));
  for (const stage of STAGES) {
    const file = `${COMMANDS[stage]}.md`;
    if (!available.has(file)) continue;
    copyFileSync(join(root, "commands", file), join(commandsOut, file));
    installed.push(join(".opencode", "commands", file));
  }

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission: permissions(state.mode),
  };
  if (state.default_model) {
    config.model = `${state.default_model.providerID}/${state.default_model.modelID}`;
  }
  writeJsonAtomic(join(workspace, "opencode.json"), config);
  installed.push("opencode.json");

  return installed;
}

/** Stages whose command markdown is not yet ported. */
export function missingCommands(): string[] {
  const available = new Set(readdirSync(join(assetRoot(), "commands")));
  return STAGES.filter((stage) => !available.has(`${COMMANDS[stage]}.md`));
}
