import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TriageReportSchema } from "../src/artifacts.js";
import {
  materialPaths,
  materialsInventory,
  materialSurvey,
  suppliedMaterials,
} from "../src/input.js";
import { ARTIFACTS, SOURCE_DIR } from "../src/paths.js";
import { validateStage, validators } from "../src/validation.js";
import type { Scope } from "../src/state/schema.js";
import { makeMessyRawMaterials, prepared, scratchDir } from "./fixtures.js";

const SCOPE = {
  idea_filename: "idea_sparse.md",
  experimental_log_filename: "experimental_log.md",
} as const;

function put(workspace: string, rel: string, body: string): void {
  const abs = join(workspace, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function workspaceWithReport(report: unknown, files: Record<string, string> = {}): string {
  const workspace = scratchDir("po-triage-");
  put(workspace, ARTIFACTS.triageReport, JSON.stringify(report, null, 2));
  for (const [rel, body] of Object.entries(files)) put(workspace, rel, body);
  return workspace;
}

const GOOD_IDEA = [
  "# Problem Statement",
  "SAM cannot segment audio-visual video.",
  "",
  "## Core Hypothesis",
  "A temporal branch plus data-driven prompts adapts it.",
  "",
  "## Contributions",
  "- TSAM",
].join("\n");

const GOOD_LOG = ["# Setup", "Ref-AVS, J and F metrics.", "", "# Results", "J 43.43"].join("\n");

function synthesizedReport(overrides: Record<string, unknown> = {}) {
  return {
    mode: "synthesized",
    idea_path: ARTIFACTS.synthesizedIdea,
    experimental_log_path: ARTIFACTS.synthesizedLog,
    materials_considered: 3,
    sources: [{ path: join(SOURCE_DIR, "notes.md"), role: "idea", why: "states the problem" }],
    claims: [
      { statement: "J is 43.43", source_path: join(SOURCE_DIR, "notes.md"), quote: "43.43" },
    ],
    unresolved: [],
    ...overrides,
  };
}

describe("TriageReportSchema", () => {
  it("rejects an empty object, unlike a byte floor", () => {
    // The existing artifact floors pass on `{}` at 2 bytes. A required
    // non-empty `sources` array cannot be satisfied that way.
    expect(TriageReportSchema.safeParse({}).success).toBe(false);
  });

  it("requires at least one source", () => {
    expect(TriageReportSchema.safeParse(synthesizedReport({ sources: [] })).success).toBe(false);
  });
});

describe("triage_grounding", () => {
  it("passes when every quote is really in the file it names", () => {
    const workspace = workspaceWithReport(synthesizedReport(), {
      [join(SOURCE_DIR, "notes.md")]: "Ref-AVS Seen J reached 43.43 after training.",
    });
    expect(validators.triageGrounding(workspace).passed).toBe(true);
  });

  it("fails a quote that is not in the file", () => {
    // The point of the check: a fabricated number cannot be quoted from a
    // file, and no length or fluency check would notice.
    const workspace = workspaceWithReport(
      synthesizedReport({
        claims: [
          { statement: "J is 99.9", source_path: join(SOURCE_DIR, "notes.md"), quote: "99.9" },
        ],
      }),
      { [join(SOURCE_DIR, "notes.md")]: "Ref-AVS Seen J reached 43.43." },
    );
    const check = validators.triageGrounding(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("99.9");
  });

  it("matches a quote across re-wrapped whitespace", () => {
    const workspace = workspaceWithReport(
      synthesizedReport({
        claims: [
          {
            statement: "the metric",
            source_path: join(SOURCE_DIR, "notes.md"),
            quote: "Seen J reached 43.43",
          },
        ],
      }),
      { [join(SOURCE_DIR, "notes.md")]: "Seen J\n   reached   43.43" },
    );
    expect(validators.triageGrounding(workspace).passed).toBe(true);
  });

  it("requires at least one claim from a synthesis", () => {
    const workspace = workspaceWithReport(synthesizedReport({ claims: [] }));
    expect(validators.triageGrounding(workspace).passed).toBe(false);
  });

  it("asks nothing of the supplied path", () => {
    const workspace = workspaceWithReport({
      ...synthesizedReport({ claims: [] }),
      mode: "supplied",
    });
    expect(validators.triageGrounding(workspace).passed).toBe(true);
  });
});

describe("triage_provenance", () => {
  it("fails a path that does not exist", () => {
    const workspace = workspaceWithReport(synthesizedReport());
    const check = validators.triageProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("does not exist");
  });

  it("fails a path that escapes the workspace", () => {
    const workspace = workspaceWithReport(
      synthesizedReport({
        sources: [{ path: "../../etc/passwd", role: "idea", why: "no" }],
        claims: [],
      }),
    );
    const check = validators.triageProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("escapes the workspace");
  });

  it("fails a path outside the material trees", () => {
    const workspace = workspaceWithReport(
      synthesizedReport({
        sources: [{ path: ".po-run/run.json", role: "idea", why: "no" }],
        claims: [],
      }),
      { ".po-run/run.json": "{}" },
    );
    expect(validators.triageProvenance(workspace).passed).toBe(false);
  });
});

describe("triage_coverage", () => {
  it("requires structure in the idea and numbers in the log", () => {
    const workspace = workspaceWithReport(synthesizedReport(), {
      [join(SOURCE_DIR, "notes.md")]: "43.43",
      [ARTIFACTS.synthesizedIdea]: GOOD_IDEA,
      [ARTIFACTS.synthesizedLog]: GOOD_LOG,
    });
    expect(validators.triageCoverage(workspace).passed).toBe(true);
  });

  it("fails a log with no measured number", () => {
    const workspace = workspaceWithReport(synthesizedReport(), {
      [join(SOURCE_DIR, "notes.md")]: "43.43",
      [ARTIFACTS.synthesizedIdea]: GOOD_IDEA,
      [ARTIFACTS.synthesizedLog]: "# Results\n\nThe method performs well.",
    });
    const check = validators.triageCoverage(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("no digits");
  });

  it("fails an idea with no structure", () => {
    const workspace = workspaceWithReport(synthesizedReport(), {
      [join(SOURCE_DIR, "notes.md")]: "43.43",
      [ARTIFACTS.synthesizedIdea]: "just a sentence",
      [ARTIFACTS.synthesizedLog]: GOOD_LOG,
    });
    expect(validators.triageCoverage(workspace).passed).toBe(false);
  });
});

describe("suppliedMaterials", () => {
  it("finds both documents in a supplied workspace", async () => {
    const { workspace } = await prepared();
    // The default fixture is deliberately the supplied case, so every existing
    // prepared-workspace test keeps taking the zero-model-call path.
    expect(suppliedMaterials(workspace, SCOPE)).toEqual({
      idea: join(SOURCE_DIR, "idea_sparse.md"),
      experimentalLog: join(SOURCE_DIR, "experimental_log.md"),
    });
  });

  it("returns null for an empty placeholder, but not for a terse document", () => {
    // The test that pins why this is a content check and not a byte floor: a
    // one-line idea is ~30 bytes, so any floor big enough to feel meaningful
    // would reject documents a user legitimately wrote.
    const empty = scratchDir("po-supplied-");
    put(empty, join(SOURCE_DIR, "idea_sparse.md"), "   \n");
    put(empty, join(SOURCE_DIR, "experimental_log.md"), "x".repeat(400));
    expect(suppliedMaterials(empty, SCOPE)).toBeNull();

    const terse = scratchDir("po-supplied-");
    put(terse, join(SOURCE_DIR, "idea_sparse.md"), "# Idea\n\nA temporal adapter for SAM.\n");
    put(terse, join(SOURCE_DIR, "experimental_log.md"), "# Log\n\nJ&F 52.1 on Ref-AVS.\n");
    expect(suppliedMaterials(terse, SCOPE)).not.toBeNull();
  });

  it("returns null when one is missing", () => {
    const workspace = scratchDir("po-supplied-");
    put(workspace, join(SOURCE_DIR, "idea_sparse.md"), "x".repeat(400));
    expect(suppliedMaterials(workspace, SCOPE)).toBeNull();
  });

  it("returns null for a binary blob wearing the right name", () => {
    const workspace = scratchDir("po-supplied-");
    writeFileSync(join(workspace, "placeholder"), "x");
    mkdirSync(join(workspace, SOURCE_DIR), { recursive: true });
    writeFileSync(
      join(workspace, SOURCE_DIR, "idea_sparse.md"),
      Buffer.concat([Buffer.alloc(300, 0x41), Buffer.from([0])]),
    );
    put(workspace, join(SOURCE_DIR, "experimental_log.md"), "x".repeat(400));
    expect(suppliedMaterials(workspace, SCOPE)).toBeNull();
  });
});

describe("materialPaths", () => {
  it("reads triage.json when it exists", () => {
    const workspace = workspaceWithReport(
      synthesizedReport({ idea_path: ".brain/input/synthesized/idea.md" }),
    );
    expect(materialPaths(workspace, SCOPE).idea).toBe(".brain/input/synthesized/idea.md");
  });

  it("falls back to source/ so a pre-triage workspace still resolves", () => {
    const workspace = scratchDir("po-fallback-");
    expect(materialPaths(workspace, SCOPE)).toEqual({
      idea: join(SOURCE_DIR, "idea_sparse.md"),
      experimentalLog: join(SOURCE_DIR, "experimental_log.md"),
    });
  });
});

describe("validateStage(triage)", () => {
  it("reports the missing artifacts on an empty workspace", () => {
    const workspace = scratchDir("po-triage-empty-");
    const checks = validateStage(workspace, "triage", { plan: ["triage"] } as unknown as Scope);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.passed)).toBe(false);
  });
});

describe("materials given to the model", () => {
  it("inventories the normalized view and excludes its own output", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.synthesizedIdea, GOOD_IDEA);
    const inventory = materialsInventory(workspace);
    expect(inventory).toContain("idea_sparse.md");
    expect(inventory).not.toContain("synthesized");
  });

  it("surveys a directory that has no named documents", () => {
    const survey = materialSurvey(makeMessyRawMaterials(), 24_000);
    expect(survey).toContain("research_overview.md");
    // Ranked, so prose beats a deep code file.
    expect(survey.indexOf("research_overview.md")).toBeLessThan(
      survey.indexOf("train.py") === -1 ? Number.MAX_SAFE_INTEGER : survey.indexOf("train.py"),
    );
    expect(survey).not.toContain("OPENAI_API_KEY");
  });
});
