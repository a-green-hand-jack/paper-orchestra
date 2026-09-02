import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeJsonAtomic } from "./files.js";
import { paths } from "./paths.js";
import { COMMANDS, STAGES } from "./stages.js";
import type { RunState } from "./state/schema.js";
import { permissionsFor } from "./permissions.js";

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

  // Written for inspection, for the native TUI, and so a checkpoint records
  // the posture a run used. The authoritative copy is handed to the server
  // directly, because file discovery does not find this path.
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission: permissionsFor(state.mode),
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
