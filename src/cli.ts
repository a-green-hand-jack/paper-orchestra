#!/usr/bin/env node
import { Command, Option } from "commander";
import { checkpoint, checkpointHistory } from "./checkpoints.js";
import { approveRun, runController } from "./controller.js";
import { statusCommand } from "./commands/status.js";
import { currentYearMonth, prepareWorkspace } from "./commands/prepare.js";
import { runDoctor } from "./doctor.js";
import { UserFacingError, ValidationFailedError } from "./errors.js";
import { formatModelRef, parseModelRef, parseStageModels } from "./model.js";
import { compactStamp } from "./timestamp.js";
import { PAPER_ORCHESTRA_VERSION } from "./version.js";
import { readRunState, resumeStage, verifyLocks } from "./state/store.js";
import { validateRun, validateStage } from "./validation.js";
import { isStageId, STAGES, type StageId } from "./stages.js";
import { bundledVenues, templateAdapters } from "./venues.js";
import {
  CCF_A_VENUES,
  manualCcfTemplateAdapter,
  manualMathTemplateAdapterForId,
  templateAdapter,
  venueDefinition,
} from "./venue-catalog.js";
import { adaptVenueKit, installOfficialVenue, manualCcfAdapter } from "./venue-install.js";
import { AUTO_TEMPLATE, resolveTemplateSelection } from "./template-selection.js";
import { resolve } from "node:path";
import { runResult } from "./automation.js";

let jsonErrors = false;
let activeWorkspace: string | null = null;

function jsonLine(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code = 1): never {
  throw new UserFacingError(message, code);
}

const program = new Command();

program
  .name("paper-orchestra")
  .description(
    "Turn raw research materials into a submission-ready LaTeX manuscript, " +
      "driving OpenCode as the agent runtime.",
  )
  .version(PAPER_ORCHESTRA_VERSION);

const templates = program
  .command("templates")
  .description("List, inspect, install, or normalize versioned venue author kits");

templates
  .command("list")
  .description("List immutable template adapters; add --ccf-a for all CCF-A venue identities")
  .option("--ccf-a", "include the 58 CCF-A venue identities", false)
  .option("--json", "machine-readable output", false)
  .action((options: { ccfA: boolean; json: boolean }) => {
    const adapters = templateAdapters();
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ adapters, ccf_a_venues: options.ccfA ? CCF_A_VENUES : undefined }, null, 2)}\n`,
      );
      return;
    }
    for (const adapter of adapters) {
      process.stdout.write(
        `${adapter.id.padEnd(20)} ${adapter.source.kind.padEnd(18)} ${adapter.title}\n`,
      );
    }
    if (options.ccfA) {
      process.stdout.write("\nCCF-A venue identities (adapt a downloaded official kit with `templates adapt`):\n");
      for (const venue of CCF_A_VENUES) {
        process.stdout.write(`${venue.key.padEnd(20)} ${venue.category} - ${venue.title}\n`);
      }
    }
  });

templates
  .command("info")
  .description("Show official authoring provenance and installation instructions")
  .argument("<id>", "template adapter id or CCF-A venue key")
  .option("--json", "machine-readable output", false)
  .action((id: string, options: { json: boolean }) => {
    const adapter = templateAdapter(id);
    const venue = venueDefinition(id);
    if (!adapter && !venue) fail(`unknown template adapter or CCF-A venue "${id}"`);
    const value = adapter ?? venue;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (adapter?.source.kind === "official-archive") {
      process.stdout.write(`\nInstall: paper-orchestra templates install ${adapter.id} ./templates/${adapter.id}\n`);
    } else if (adapter?.source.kind === "manual") {
      const venueFlag = adapter.venueKey ? ` --venue ${adapter.venueKey} --year ${adapter.year}` : "";
      process.stdout.write(
        `\nDownload the exact official kit for this edition, then normalize it:\n` +
          `paper-orchestra templates adapt ${adapter.id} /path/to/kit ./templates/${adapter.id}${venueFlag} --entry <main.tex> --source-url <official-cfp-or-kit-url>\n`,
      );
    } else if (venue) {
      process.stdout.write(
          `\nDownload the exact author kit linked by the target edition, then normalize it:\n` +
          `paper-orchestra templates adapt <${venue.key}-year-id> /path/to/kit ./templates/<${venue.key}-year-id> --venue ${venue.key} --year <released-year> --entry <main.tex> --source-url <official-cfp-or-kit-url>\n` +
          "The adapter ID removes hyphens from the venue key (for example, `usenixatc2025`).\n",
      );
    }
  });

templates
  .command("install")
  .description("Download a checksum-pinned official author kit into a local template directory")
  .argument("<id>", "official-download adapter id")
  .argument("<destination>", "new local template directory")
  .action(async (id: string, destination: string) => {
    const installed = await installOfficialVenue(id, destination);
    process.stdout.write(`installed ${installed.id} in ${installed.directory}\n`);
  });

templates
  .command("adapt")
  .description("Normalize a locally downloaded official kit without modifying its style files")
  .argument("<id>", "immutable adapter id, for example fast2026")
  .argument("<source-directory>", "directory containing the official author kit")
  .argument("<destination>", "new local template directory")
  .requiredOption("--entry <relative-file>", "main .tex file within the official kit")
  .requiredOption("--source-url <https-url>", "exact official kit or CFP URL")
  .option("--venue <ccf-a-key>", "CCF-A venue key for a manual adapter")
  .option("--year <year>", "edition year for a manual CCF-A adapter")
  .action(
    (
      id: string,
      sourceDirectory: string,
      destination: string,
      options: { entry: string; sourceUrl: string; venue?: string; year?: string },
    ) => {
      let venueKey: string | null = null;
      let year: number | null = null;
      let adapter = templateAdapter(id) ?? manualMathTemplateAdapterForId(id) ?? null;
      if (options.venue || options.year) {
        if (!options.venue || !options.year) {
          fail("manual CCF-A adapters require both --venue and --year");
        }
        const manual = manualCcfAdapter(id, options.venue, Number(options.year));
        venueKey = manual.venueKey;
        year = manual.year;
        adapter = manualCcfTemplateAdapter(manual.venueKey, manual.year);
      } else if (!adapter || adapter.source.kind !== "manual") {
        fail(
          `${id} is not a manual adapter. Use \`paper-orchestra templates install ${id} <destination>\` ` +
            "when an official-download adapter is available.",
        );
      } else {
        venueKey = adapter.venueKey;
        year = adapter.year;
      }
      const installed = adaptVenueKit({
        id,
        sourceDirectory,
        sourceUrl: options.sourceUrl,
        destination,
        entrypoint: options.entry,
        adapter,
        venueKey,
        year,
      });
      process.stdout.write(`adapted ${installed.id} in ${installed.directory}\n`);
    },
  );

program
  .command("write")
  .description("Create a workspace and run the writing pipeline")
  // Optional, defaulting to the working directory: the intended workflow is to
  // cd into the materials and run `paper-orchestra write`.
  .argument("[raw-materials]", "directory holding the idea and experimental log", ".")
  .option(
    "--template <venue|dir|auto>",
    "template directory or immutable adapter id; default auto selects from the paper topic",
    AUTO_TEMPLATE,
  )
  .option("-o, --output <dir>", "workspace directory (default: ./po-run-<timestamp>)")
  .addOption(
    new Option("--mode <mode>", "gate behaviour").choices(["autonomous", "collaborative"]).default(
      "autonomous",
    ),
  )
  .option("--headless", "run without attaching the OpenCode TUI", false)
  .option("--use-plotting", "generate figures instead of using supplied ones", false)
  .option("--model <ref>", "provider/model[:variant]; omit to use OpenCode's default")
  .option(
    "--stage-model <entry>",
    "per-stage override, e.g. literature=openai/gpt-5-mini (repeatable)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("--research-cutoff <yyyy-mm>", "literature cutoff (default: current month)")
  .option("--idea-filename <name>", "idea document within raw materials", "idea_sparse.md")
  .option(
    "--experimental-log-filename <name>",
    "experimental log within raw materials",
    "experimental_log.md",
  )
  .addOption(
    new Option("--network-policy <policy>", "whether stages may reach the network")
      .choices(["online", "offline"])
      .default("online"),
  )
  .option("--timeout-multiplier <n>", "scale every stage timeout", "1")
  .option(
    "--until <stage>",
    "stop after this stage, locking a shorter plan (outline, literature, plotting, section_writing, refinement)",
  )
  .option(
    "--allow-lkm-spend",
    "authorize paid Bohrium LKM literature retrieval (~0.05 CNY per call)",
    false,
  )
  .option("--max-lkm-calls <n>", "ceiling on literature retrieval calls", "40")
  .option(
    "--target-citations <n>",
    "how many distinct sources the manuscript should cite, capped by how many relevant ones retrieval found",
    "20",
  )
  .option("--prepare-only", "create and lock the workspace, then stop", false)
  .option("--json", "newline-delimited machine-readable events and result", false)
  .action(async (rawMaterials: string, options: Record<string, unknown>) => {
    const workspace = (options.output as string | undefined) ?? `./po-run-${compactStamp()}`;
    jsonErrors = Boolean(options.json);
    activeWorkspace = resolve(workspace);
    if (options.until && !isStageId(options.until as string)) {
      fail(`unknown --until stage "${options.until}"; expected one of ${STAGES.join(", ")}`);
    }
    const multiplier = Number(options.timeoutMultiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      fail(`--timeout-multiplier must be a positive number, got "${options.timeoutMultiplier}"`);
    }

    const defaultModel = options.model ? parseModelRef(options.model as string) : null;
    const selectedTemplate = await resolveTemplateSelection({
      requested: options.template as string,
      rawMaterials,
      ideaFilename: options.ideaFilename as string,
      experimentalLogFilename: options.experimentalLogFilename as string,
      model: defaultModel,
    });

    const result = await prepareWorkspace({
      workspace,
      rawMaterials,
      templateDir: selectedTemplate.directory,
      templateId: selectedTemplate.templateId,
      templateSelection: selectedTemplate.mode,
      templateRationale: selectedTemplate.rationale,
      mode: options.mode as "autonomous" | "collaborative",
      headless: Boolean(options.headless),
      usePlotting: Boolean(options.usePlotting),
      researchCutoff: (options.researchCutoff as string | undefined) ?? currentYearMonth(),
      ideaFilename: options.ideaFilename as string,
      experimentalLogFilename: options.experimentalLogFilename as string,
      networkPolicy: options.networkPolicy as "online" | "offline",
      defaultModel,
      stageModels: parseStageModels(options.stageModel as string[]),
      timeoutMultiplier: multiplier,
      until: (options.until as StageId | undefined) ?? null,
      maxLkmCalls: Number(options.maxLkmCalls),
      targetCitations: Number(options.targetCitations),
    });

    const { state } = result;
    if (options.json) {
      jsonLine({
        type: "prepared",
        workspace: resolve(workspace),
        run_id: state.run_id,
        plan: state.scope.plan,
        template: {
          id: state.scope.template_id ?? state.scope.venue,
          selection: state.scope.template_selection ?? "explicit",
          rationale: state.scope.template_rationale ?? "",
        },
        checkpoint: result.checkpointSha,
      });
    } else {
      process.stdout.write(`prepared ${state.run_id} in ${workspace}\n`);
      process.stdout.write(`  branch    ${state.run_branch}\n`);
      process.stdout.write(`  venue     ${state.scope.venue}\n`);
      process.stdout.write(
        `  selection ${state.scope.template_selection ?? "explicit"} (${state.scope.template_rationale ?? "user-selected"})\n`,
      );
      process.stdout.write(`  plan      ${state.scope.plan.join(" -> ")}\n`);
      process.stdout.write(`  model     ${formatModelRef(state.default_model)}\n`);
      process.stdout.write(`  source    ${state.source_digest.slice(0, 12)}\n`);
      process.stdout.write(`  template  ${state.template_digest.slice(0, 12)}\n`);
      process.stdout.write(`  brain     ${result.brainInputs.length} normalized input(s)\n`);
      process.stdout.write(`  ckpt      ${result.checkpointSha.slice(0, 12)}\n`);
    }

    if (!options.json && result.skipped.length > 0) {
      process.stdout.write(`  skipped   ${result.skipped.length} file(s) during import:\n`);
      for (const entry of result.skipped.slice(0, 10)) {
        process.stdout.write(`              ${entry}\n`);
      }
      if (result.skipped.length > 10) {
        process.stdout.write(`              ... and ${result.skipped.length - 10} more\n`);
      }
    }

    if (options.prepareOnly) {
      if (options.json) jsonLine(runResult(workspace, state));
      return;
    }

    if (!options.json) process.stdout.write("\n");
    const final = await runController({
      workspace,
      headless: Boolean(options.headless),
      allowLkmSpend: Boolean(options.allowLkmSpend),
      ...(options.json
        ? { onEvent: (message: string) => jsonLine({ type: "event", message }) }
        : {}),
    });
    if (options.json) jsonLine(runResult(workspace, final));
  });

program
  .command("status")
  .description("Show stage progress for a run")
  .argument("[workspace]", "run workspace", ".")
  .option("--json", "machine-readable output", false)
  .action(async (workspace: string, options: { json: boolean }) => {
    await statusCommand(workspace, options.json);
  });

program
  .command("checkpoint")
  .description("Take a manual checkpoint of the current workspace state")
  .argument("[workspace]", "run workspace", ".")
  .action(async (workspace: string) => {
    const state = readRunState(workspace);
    const sha = await checkpoint({
      workspace,
      runId: state.run_id,
      stage: state.current_stage ?? "manual",
      status: "manual",
      mode: state.mode,
      model: formatModelRef(state.default_model),
    });
    process.stdout.write(`checkpoint ${sha.slice(0, 12)}\n`);
  });

program
  .command("history")
  .description("List the checkpoint timeline")
  .argument("[workspace]", "run workspace", ".")
  .action(async (workspace: string) => {
    const records = await checkpointHistory(workspace);
    if (records.length === 0) {
      process.stdout.write("no checkpoints\n");
      return;
    }
    for (const record of records) {
      process.stdout.write(
        `${record.sha.slice(0, 12)}  ${(record.stage ?? "?").padEnd(16)} ` +
          `${(record.status ?? "?").padEnd(12)} ${record.validation ?? ""}\n`,
      );
    }
  });

program
  .command("resume")
  .description("Continue a run from its first unfinished stage")
  .argument("[workspace]", "run workspace", ".")
  .option(
    "--allow-lkm-spend",
    "authorize paid Bohrium LKM literature retrieval (~0.05 CNY per call)",
    false,
  )
  .option("--headless", "resume without attaching the OpenCode TUI", false)
  .option("--json", "newline-delimited machine-readable events and result", false)
  .action(async (
    workspace: string,
    options: { allowLkmSpend: boolean; headless: boolean; json: boolean },
  ) => {
    jsonErrors = options.json;
    activeWorkspace = resolve(workspace);
    const state = readRunState(workspace);
    verifyLocks(workspace, state);
    const next = resumeStage(state);
    if (!next && state.status === "completed") {
      if (options.json) jsonLine(runResult(workspace, state));
      else process.stdout.write(`${state.run_id} is already complete\n`);
      return;
    }
    if (!options.json) {
      process.stdout.write(
        next
          ? `resuming ${state.run_id} at "${next}"\n`
          : `finalizing approved run ${state.run_id}\n`,
      );
    }
    const final = await runController({
      workspace,
      headless: options.headless || state.headless,
      allowLkmSpend: Boolean(options.allowLkmSpend),
      ...(options.json
        ? { onEvent: (message: string) => jsonLine({ type: "event", message }) }
        : {}),
    });
    if (options.json) jsonLine(runResult(workspace, final));
  });

program
  .command("validate")
  .description("Run artifact validators against a workspace without prompting a model")
  .argument("[workspace]", "run workspace", ".")
  .option("--stage <stage>", `validate one stage only (${STAGES.join(", ")})`)
  .option("--json", "machine-readable output", false)
  .action(async (workspace: string, options: { stage?: string; json: boolean }) => {
    const state = readRunState(workspace);
    if (options.stage && !isStageId(options.stage)) {
      fail(`unknown stage "${options.stage}"; expected one of ${STAGES.join(", ")}`);
    }
    const checks = options.stage
      ? validateStage(workspace, options.stage as (typeof STAGES)[number], state.scope)
      : validateRun(workspace, state.scope.plan, state.scope);

    const failed = checks.filter((check) => !check.passed);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ checks, failed: failed.length }, null, 2)}\n`);
    } else {
      for (const check of checks) {
        process.stdout.write(`${check.passed ? "pass" : "FAIL"}  ${check.name}\n`);
        if (!check.passed) process.stdout.write(`      ${check.detail}\n`);
      }
      process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
    }

    if (failed.length > 0) {
      // Exit 2 rather than 1 so a script can distinguish "validation failed"
      // from "the command could not run".
      throw new ValidationFailedError(
        `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`,
      );
    }
  });

program
  .command("approve")
  .description("Release a collaborative run waiting at a gate")
  .argument("[workspace]", "run workspace", ".")
  .action(async (workspace: string) => {
    const state = approveRun(workspace);
    process.stdout.write(
      `approved ${state.run_id}; the controller will continue at "${state.current_stage ?? "?"}"\n`,
    );
  });

program
  .command("doctor")
  .description("Check the environment a run depends on")
  .action(async () => {
    const { checks, probes, ok } = await runDoctor();
    for (const check of checks) {
      process.stdout.write(`${check.passed ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}\n`);
    }
    for (const probe of probes) {
      process.stdout.write(
        `${probe.satisfied ? "ok  " : "warn"}  ${probe.name}: ${probe.detail}\n`,
      );
    }
    if (!ok) fail("environment is missing a hard requirement (see FAIL lines above)");
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof UserFacingError) {
      if (jsonErrors) {
        let runState: string | null = null;
        if (activeWorkspace) {
          try {
            runState = readRunState(activeWorkspace).status;
          } catch {
            // Preparation may have failed before a state file existed.
          }
        }
        process.stderr.write(
          `${JSON.stringify({
            type: "error",
            ok: false,
            exit_status: error.exitCode,
            workspace: activeWorkspace,
            run_state: runState,
            validation_failures: [error.message],
            error: error.message,
          })}\n`,
        );
      } else {
        process.stderr.write(`paper-orchestra: ${error.message}\n`);
      }
      process.exit(error.exitCode);
    }
    throw error;
  }
}

await main();
