import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRemediationPrompt, buildStagePrompt, loadCommand, substitute } from "../src/prompts.js";
import { COMMANDS } from "../src/stages.js";
import type { Check, Scope } from "../src/state/schema.js";
import { prepared } from "./fixtures.js";

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    plan: ["outline"],
    use_plotting: false,
    research_cutoff: "2024-11",
    idea_filename: "idea_sparse.md",
    experimental_log_filename: "experimental_log.md",
    venue: "cvpr2025",
    network_policy: "online",
    ...overrides,
  };
}

describe("substitute", () => {
  it("replaces named placeholders", () => {
    expect(substitute("cutoff is {cutoff_date}.", { cutoff_date: "2024-11" })).toBe(
      "cutoff is 2024-11.",
    );
  });

  it("replaces every occurrence", () => {
    expect(substitute("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("leaves literal LaTeX braces alone", () => {
    // The ported prompts contain braces that look exactly like placeholders.
    // A generic template engine would blank these out or throw.
    const tex = "\\usepackage[capitalize]{cleveref} and \\cite{Hu2021LoraLowrank}";
    expect(substitute(tex, { cutoff_date: "2024-11" })).toBe(tex);
  });

  it("does not invent values for placeholders it was not given", () => {
    expect(substitute("{paper_count} papers", {})).toBe("{paper_count} papers");
  });
});

describe("loadCommand", () => {
  it("strips the generated header comment", async () => {
    const { workspace } = await prepared();
    const dir = join(workspace, ".opencode", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${COMMANDS.outline}.md`),
      "<!--\nPorted from somewhere.\n-->\n\nReal prompt body here.\n",
    );
    expect(loadCommand(workspace, "outline")).toBe("Real prompt body here.");
  });

  it("fails with an actionable message when assets are missing", async () => {
    const { workspace } = await prepared();
    expect(() => loadCommand(workspace, "outline")).toThrow(/\.opencode assets are incomplete/);
  });
});

describe("buildStagePrompt", () => {
  it("substitutes the cutoff and states the workspace contract", async () => {
    const { workspace } = await prepared();
    const dir = join(workspace, ".opencode", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${COMMANDS.outline}.md`), "Cutoff: {cutoff_date}\n");

    const built = buildStagePrompt(workspace, "outline", scope());
    expect(built).toContain("Cutoff: 2024-11");
    expect(built).toContain(".brain/raw/outline.json");
    expect(built).toContain("source/idea_sparse.md");
  });

  it("tells the model its closing message is not read", async () => {
    // Removes the incentive to claim completion, which is the failure mode a
    // validator-driven controller exists to prevent.
    const { workspace } = await prepared();
    const dir = join(workspace, ".opencode", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${COMMANDS.outline}.md`), "body");
    const built = buildStagePrompt(workspace, "outline", scope());
    expect(built).toMatch(/does not read your closing message/);
    expect(built).toMatch(/read-only inputs/);
  });

  it("inlines the exact citation keys for manuscript stages", async () => {
    const { workspace } = await prepared();
    const dir = join(workspace, ".opencode", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${COMMANDS.section_writing}.md`), "body");

    const built = buildStagePrompt(workspace, "section_writing", scope(), {
      citation_keys: "Author2024Exact, Research2023Verified",
    });
    expect(built).toContain("The only permitted citation keys");
    expect(built).toContain("Author2024Exact, Research2023Verified");
  });
});

describe("buildRemediationPrompt", () => {
  const failed: Check[] = [
    {
      name: "citation_integrity",
      passed: false,
      detail: "expected every \\cite key to be defined in references.bib; missing: ghost2024z",
    },
  ];

  it("carries the check name and detail in verbatim", () => {
    // Every validator detail is phrased as an expectation precisely because it
    // lands here unaltered: the check message is the repair instruction.
    const built = buildRemediationPrompt("section_writing", failed);
    expect(built).toContain("citation_integrity");
    expect(built).toContain("ghost2024z");
    expect(built).toContain("copy its `citation_key` values exactly");
  });

  it("forbids satisfying a check by editing supplied inputs", () => {
    // paper-run's evaluation recorded an agent re-adding a marker to a
    // read-only supplied file because the validator error asked for it.
    expect(buildRemediationPrompt("section_writing", failed)).toMatch(
      /do not modify anything under `source\/` or\n`template\/`/,
    );
  });

  it("scopes the work to the findings", () => {
    expect(buildRemediationPrompt("outline", failed)).toMatch(/nothing else/);
  });
});
