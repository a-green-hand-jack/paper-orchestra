import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACTS } from "../src/paths.js";
import type { Scope } from "../src/state/schema.js";
import { validateStage, validators } from "../src/validation.js";
import { prepared } from "./fixtures.js";

function put(workspace: string, rel: string, content: string): void {
  const abs = join(workspace, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function json(workspace: string, rel: string, value: unknown): void {
  put(workspace, rel, JSON.stringify(value, null, 2));
}

const GOOD_OUTLINE = {
  plotting_plan: [
    { figure_id: "overview", title: "Overview", plot_type: "diagram", aspect_ratio: "16:9" },
  ],
  intro_related_work_plan: {
    introduction_strategy: { hook_hypothesis: "h", search_directions: ["sam temporal"] },
    related_work_strategy: { overview: "o", subsections: [{ subsection_title: "SAM variants" }] },
  },
  section_plan: [
    {
      section_title: "Introduction",
      subsections: [{ subsection_title: "Motivation" }, { subsection_title: "Contributions" }],
    },
    // Abstract legitimately needs no subsections; the prompt says to omit them
    // when a section does not require division.
    { section_title: "Abstract", subsections: [] },
  ],
};

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    plan: ["outline", "literature", "plotting", "section_writing", "refinement"],
    use_plotting: false,
    research_cutoff: "2026-01",
    idea_filename: "idea_sparse.md",
    experimental_log_filename: "experimental_log.md",
    venue: "cvpr2025",
    network_policy: "online",
    max_lkm_calls: 40,
    target_citations: 20,
    ...overrides,
  };
}

function failures(checks: ReturnType<typeof validateStage>): string[] {
  return checks.filter((c) => !c.passed).map((c) => c.name);
}

describe("outline stage", () => {
  it("fails when the artifact is missing, naming what to write", async () => {
    const { workspace } = await prepared();
    const checks = validateStage(workspace, "outline", scope());
    const first = checks.find((c) => !c.passed);
    expect(first?.detail).toMatch(/expected .*outline\.json to exist/);
  });

  it("passes a well-formed outline", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, GOOD_OUTLINE);
    expect(failures(validateStage(workspace, "outline", scope()))).toEqual([]);
  });

  it("rejects malformed JSON with a parse message rather than a crash", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.outline, "{not json at all, padded to clear the size floor,,,}");
    const checks = validateStage(workspace, "outline", scope());
    expect(failures(checks)).toContain(`schema_valid:${ARTIFACTS.outline}`);
    const parseCheck = checks.find((c) => c.name === `schema_valid:${ARTIFACTS.outline}`);
    expect(parseCheck?.detail).toMatch(/does not parse/);
  });

  it("rejects an empty figure_id, which the Python uses as a filename", async () => {
    // plotting_agent.py:258 does figure_id.replace(...), which throws on null.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, {
      ...GOOD_OUTLINE,
      plotting_plan: [{ figure_id: "" }],
    });
    const checks = validateStage(workspace, "outline", scope());
    expect(failures(checks)).toContain(`schema_valid:${ARTIFACTS.outline}`);
  });

  it("rejects an empty section plan", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, { ...GOOD_OUTLINE, section_plan: [] });
    expect(failures(validateStage(workspace, "outline", scope()))).toContain("outline_coverage");
  });

  it("accepts a section that legitimately needs no subsections", async () => {
    // Regression: outline_coverage used to require at least one subsection,
    // contradicting the prompt's "omit subsections entirely if a section does
    // not require division" and burning a remediation round to make the model
    // subdivide an Abstract.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, {
      ...GOOD_OUTLINE,
      section_plan: [{ section_title: "Conclusion", subsections: [] }],
    });
    expect(validators.outlineCoverage(workspace).passed).toBe(true);
  });

  it("does not gate on subsection count in either direction", async () => {
    // Regression, twice over. It first required >=1 subsection, contradicting
    // the prompt and costing a live remediation round that made the model
    // subdivide an Abstract. It was then briefly changed to reject a lone
    // subsection, which both real runs also failed. Nothing downstream depends
    // on the count, so it is the prompt's business, not a floor.
    const { workspace } = await prepared();
    for (const subsections of [
      [],
      [{ subsection_title: "Only one" }],
      [{ subsection_title: "A" }, { subsection_title: "B" }],
    ]) {
      json(workspace, ARTIFACTS.outline, {
        ...GOOD_OUTLINE,
        section_plan: [{ section_title: "Method", subsections }],
      });
      expect(validators.outlineCoverage(workspace).passed).toBe(true);
    }
  });

  it("rejects duplicate figure ids because they collide as filenames", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, {
      ...GOOD_OUTLINE,
      plotting_plan: [{ figure_id: "fig1" }, { figure_id: "fig1" }],
    });
    expect(validators.outlineCoverage(workspace).detail).toMatch(/duplicated: fig1/);
  });

  it("accepts an outline that already carries citation_candidates", async () => {
    // The literature stage rewrites the outline, deleting citation_hints and
    // adding citation_candidates. Both shapes must parse.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, {
      ...GOOD_OUTLINE,
      section_plan: [
        {
          section_title: "Introduction",
          subsections: [
            { subsection_title: "Motivation", citation_candidates: ["smith2024sam"] },
            { subsection_title: "Contributions", citation_candidates: ["jones2023avs"] },
          ],
        },
      ],
    });
    expect(failures(validateStage(workspace, "outline", scope()))).toEqual([]);
  });
});

describe("citation integrity", () => {
  it("fails a manuscript that cites a key absent from the bibliography", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{real2024a, title={Real}}\n");
    put(workspace, ARTIFACTS.rawDraft, "Prose \\cite{invented2024x}.");
    const check = validators.citationIntegrity(workspace, ARTIFACTS.rawDraft);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("invented2024x");
  });

  it("tells the model not to fix it by editing the bibliography", async () => {
    // The remediation prompt is this detail verbatim; paper-run's eval showed
    // an agent satisfying a checker by editing its supplied inputs.
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{real2024a, title={Real}}\n");
    put(workspace, ARTIFACTS.rawDraft, "Prose \\cite{invented2024x}.");
    expect(validators.citationIntegrity(workspace, ARTIFACTS.rawDraft).detail).toMatch(
      /do not add entries to the bibliography by hand/,
    );
  });

  it("fails a manuscript that cites nothing at all", async () => {
    // The exact failure that produced citation F1 0.000 in paper-run's eval:
    // "no invented citations" satisfied by citing nothing.
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{real2024a, title={Real}}\n");
    put(workspace, ARTIFACTS.rawDraft, "Prose with no citations whatsoever.");
    const check = validators.citationIntegrity(workspace, ARTIFACTS.rawDraft);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/at least one reference/);
    expect(check.detail).toMatch(/holds 1 entries/);
  });

  it("passes when every cited key resolves", async () => {
    const { workspace } = await prepared();
    put(
      workspace,
      ARTIFACTS.references,
      "@article{a2024x, title={A}}\n@inproceedings{b2023y, title={B}}\n",
    );
    put(workspace, ARTIFACTS.rawDraft, "As shown \\citep{a2024x, b2023y}.");
    expect(validators.citationIntegrity(workspace, ARTIFACTS.rawDraft).passed).toBe(true);
  });
});

describe("citation floor", () => {
  /** A citation map with `count` distinct vetted sources. */
  function sources(count: number): Record<string, unknown> {
    return Object.fromEntries(
      Array.from({ length: count }, (_, at) => [
        `Key${at}`,
        { citation_key: `Key${at}`, title: `Paper ${at}` },
      ]),
    );
  }

  function cites(count: number): string {
    return Array.from({ length: count }, (_, at) => `\\cite{Key${at}}`).join(" ");
  }

  it("fails a manuscript that cites far fewer sources than it was given", async () => {
    // The measured defect: refinement discarded ~75% of the citations two runs
    // running (84 to 20, 67 to 16) and nothing anywhere noticed.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, sources(40));
    put(workspace, ARTIFACTS.finalTex, cites(6));

    const check = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("at least 20");
    expect(check.detail).toContain("it cites 6");
  });

  it("caps the floor at what retrieval actually found", async () => {
    // A run that legitimately found only eight relevant papers must not be
    // failed for citing eight of eight.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, sources(8));
    put(workspace, ARTIFACTS.finalTex, cites(8));

    expect(validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope()).passed).toBe(true);
  });

  it("counts distinct keys, so repeating one citation cannot satisfy the floor", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, sources(40));
    put(workspace, ARTIFACTS.finalTex, "\\cite{Key0} ".repeat(30));

    const check = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("it cites 1");
  });

  it("tells the model not to pad, since the detail becomes the repair instruction", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, sources(40));
    put(workspace, ARTIFACTS.finalTex, cites(2));

    const check = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(check.detail).toContain("do not invent keys");
    expect(check.detail).toContain("do not pad");
  });

  it("honours a run that deliberately targets fewer citations", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, sources(40));
    put(workspace, ARTIFACTS.finalTex, cites(6));

    expect(
      validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope({ target_citations: 5 }))
        .passed,
    ).toBe(true);
  });

  it("is enforced at drafting as well as refinement", async () => {
    // A floor checked only at the end is discovered too late to repair cheaply.
    const { workspace } = await prepared();
    const names = validateStage(workspace, "section_writing", scope()).map((c) => c.name);
    expect(names).toContain("citation_floor");
    expect(validateStage(workspace, "refinement", scope()).map((c) => c.name)).toContain(
      "citation_floor",
    );
  });

  it("reports a missing citation map as data rather than throwing", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.finalTex, cites(3));
    const check = validators.citationFloorCheck(workspace, ARTIFACTS.finalTex, scope());
    expect(check.passed).toBe(false);
    expect(check.name).toBe("citation_floor");
  });
});

describe("literature dedup and provenance", () => {
  it("fails when two keys describe the same paper", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, {
      smith2024sam: { citation_key: "smith2024sam", title: "Segment Anything!" },
      smith2024samb: { citation_key: "smith2024samb", title: "segment anything" },
    });
    const check = validators.literatureDedup(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("smith2024sam/smith2024samb");
  });

  it("passes distinct references", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.citationMap, {
      a2024x: { citation_key: "a2024x", title: "Alpha" },
      b2023y: { citation_key: "b2023y", title: "Beta" },
    });
    expect(validators.literatureDedup(workspace).passed).toBe(true);
  });

  it("fails a bibliography entry with no retrieval record", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{ghost2024z, title={Ghost}}\n");
    json(workspace, ARTIFACTS.candidates, []);
    const check = validators.bibliographyProvenance(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("ghost2024z");
  });

  it("passes when every entry traces to a provider", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.references, "@article{a2024x, title={Alpha}}\n");
    json(workspace, ARTIFACTS.candidates, [
      {
        citation_key: "a2024x",
        title: "Alpha",
        provider: "semantic_scholar",
        provider_id: "abc123",
        retrieved_at: "2026-09-02T00:00:00.000Z",
      },
    ]);
    expect(validators.bibliographyProvenance(workspace).passed).toBe(true);
  });
});

describe("figure coverage", () => {
  it("fails when info.json names a figure that never rendered", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    const check = validators.figureCoverage(workspace, scope(), null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("overview.png");
  });

  it("fails when a rendered figure is never included by the manuscript", async () => {
    const { workspace } = await prepared();
    put(workspace, join(ARTIFACTS.figuresDir, "overview.png"), "png");
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    put(workspace, ARTIFACTS.rawDraft, "No figures included here.");
    const check = validators.figureCoverage(workspace, scope(), ARTIFACTS.rawDraft);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/never \\includegraphics/);
  });

  it("passes when the manuscript includes the figure, extension aside", async () => {
    const { workspace } = await prepared();
    put(workspace, join(ARTIFACTS.figuresDir, "overview.png"), "png");
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    put(workspace, ARTIFACTS.rawDraft, "\\includegraphics[width=1cm]{figures/overview}");
    expect(validators.figureCoverage(workspace, scope(), ARTIFACTS.rawDraft).passed).toBe(true);
  });

  it("requires plotting_results when plotting is enabled", async () => {
    const { workspace } = await prepared();
    put(workspace, join(ARTIFACTS.figuresDir, "overview.png"), "png");
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    const check = validators.figureCoverage(workspace, scope({ use_plotting: true }), null);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/plotting_results\.json/);
  });

  it("fails a planned figure that produced no image", async () => {
    const { workspace } = await prepared();
    put(workspace, join(ARTIFACTS.figuresDir, "overview.png"), "png");
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    json(workspace, ARTIFACTS.plottingResults, [{ figure_id: "missing_one" }]);
    const check = validators.figureCoverage(workspace, scope({ use_plotting: true }), null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("missing_one");
  });
});

describe("figure_render", () => {
  function bytes(n: number): string {
    return "x".repeat(n);
  }

  it("rejects a rendered file that is really an empty canvas", async () => {
    // The defect it exists for: plt.close() before savefig writes a valid,
    // tiny file that exists, satisfies figure_coverage, and prints blank.
    const { workspace } = await prepared();
    put(workspace, "figures/blank.pdf".replace("figures/", ".brain/manuscript/figures/"), bytes(40));
    json(workspace, ARTIFACTS.plottingResults, [
      { figure_id: "f1", image_path: "figures/blank.pdf" },
    ]);

    const check = validators.figureRender(workspace, scope({ use_plotting: true }));
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("empty canvas");
  });

  it("passes a figure with real content", async () => {
    const { workspace } = await prepared();
    put(workspace, ".brain/manuscript/figures/real.pdf", bytes(9000));
    json(workspace, ARTIFACTS.plottingResults, [
      { figure_id: "f1", image_path: "figures/real.pdf" },
    ]);

    expect(validators.figureRender(workspace, scope({ use_plotting: true })).passed).toBe(true);
  });

  it("fails when the recorded path names no file at all", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.plottingResults, [
      { figure_id: "f1", image_path: "figures/ghost.pdf" },
    ]);

    const check = validators.figureRender(workspace, scope({ use_plotting: true }));
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("does not exist");
  });

  it("leaves the unrendered case to figure_coverage rather than double-reporting", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.plottingResults, [{ figure_id: "f1" }]);
    expect(validators.figureRender(workspace, scope({ use_plotting: true })).passed).toBe(true);
  });

  it("is inert when plotting is off, since supplied figures are the author's", async () => {
    const { workspace } = await prepared();
    expect(validators.figureRender(workspace, scope({ use_plotting: false })).passed).toBe(true);
  });

  it("is wired into the plotting stage when generation is on", async () => {
    const { workspace } = await prepared();
    const names = validateStage(workspace, "plotting", scope({ use_plotting: true })).map(
      (c) => c.name,
    );
    expect(names).toContain("figure_render");
  });
});

describe("template compatibility", () => {
  it("fails when the manuscript changes the document class", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.rawDraft, "\\documentclass{book}\n");
    const check = validators.templateCompatibility(workspace, ARTIFACTS.rawDraft);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("book");
  });

  it("passes when the class matches the template", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.rawDraft, "\\documentclass[10pt,twocolumn,letterpaper]{article}\n");
    expect(validators.templateCompatibility(workspace, ARTIFACTS.rawDraft).passed).toBe(true);
  });
});

describe("unresolved markers", () => {
  it("fails a final manuscript with a TODO deferral", async () => {
    const { workspace } = await prepared();
    put(
      workspace,
      ARTIFACTS.finalTex,
      "\\section{Related Work}\n% TODO(paper-orchestra): add discussion once sources are verified\n",
    );
    const check = validators.noUnresolvedMarkers(workspace, ARTIFACTS.finalTex);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("TODO(paper-orchestra)");
  });

  it("passes a finished manuscript", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.finalTex, "\\section{Intro}\nReal prose \\cite{a2024x}.\n");
    expect(validators.noUnresolvedMarkers(workspace, ARTIFACTS.finalTex).passed).toBe(true);
  });
});

describe("stage wiring", () => {
  it("short-circuits plotting cleanly when it is disabled", async () => {
    const { workspace } = await prepared();
    put(workspace, join(ARTIFACTS.figuresDir, "overview.png"), "png");
    json(workspace, ARTIFACTS.figuresInfo, [{ name: "overview.png", caption: "c" }]);
    const checks = validateStage(workspace, "plotting", scope({ use_plotting: false }));
    expect(checks.map((c) => c.name)).toContain("plotting_disabled");
    expect(failures(checks)).toEqual([]);
  });

  it("returns checks for every stage without throwing on an empty workspace", async () => {
    const { workspace } = await prepared();
    for (const stage of ["outline", "literature", "plotting", "section_writing", "refinement"] as const) {
      const checks = validateStage(workspace, stage, scope({ use_plotting: true }));
      expect(checks.length).toBeGreaterThan(0);
      // Validators report, never throw: that is what lets `validate` print a
      // full table instead of dying on the first missing file.
      expect(checks.every((c) => typeof c.detail === "string" && c.detail.length > 0)).toBe(true);
    }
  });
});

describe("validators never throw", () => {
  // Regression: outlineCoverage, literatureDedup, bibliographyProvenance and
  // figureCoverage all called JSON.parse unguarded, so malformed model output
  // aborted the whole validation pass instead of producing a failed check.
  const GARBAGE = "{not json at all,,,}";

  it.each([
    ["outline", ARTIFACTS.outline],
    ["literature", ARTIFACTS.citationMap],
    ["literature", ARTIFACTS.candidates],
    ["plotting", ARTIFACTS.plottingResults],
    ["plotting", ARTIFACTS.figuresInfo],
  ] as const)("reports rather than throws when %s reads malformed %s", async (stage, rel) => {
    const { workspace } = await prepared();
    put(workspace, rel, GARBAGE);
    put(workspace, ARTIFACTS.references, "@article{a2024x, title={A}}\n");
    let checks: ReturnType<typeof validateStage> = [];
    expect(() => {
      checks = validateStage(workspace, stage, scope({ use_plotting: true }));
    }).not.toThrow();
    const failed = checks.filter((c) => !c.passed);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((c) => /does not parse/.test(c.detail))).toBe(true);
  });

  it("still reports a schema violation as data, not an exception", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.outline, { section_plan: [{ subsections: [] }] });
    let checks: ReturnType<typeof validateStage> = [];
    expect(() => {
      checks = validateStage(workspace, "outline", scope());
    }).not.toThrow();
    expect(checks.some((c) => !c.passed && /match its schema/.test(c.detail))).toBe(true);
  });
});

describe("latex_assembly", () => {
  it("fails when the controller has not compiled anything", async () => {
    const { workspace } = await prepared();
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/no build report/);
  });

  it("turns LaTeX errors into the repair instruction", async () => {
    // In the Python a compile failure merely `continue`s the reflection loop,
    // so a paper that never produced a PDF could still end a run as success.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, {
      ok: false,
      source: ARTIFACTS.finalTex,
      pdf: null,
      pages: null,
      errors: ["! Undefined control sequence. l.12 \\badmacro"],
      built_at: "2026-09-02T00:00:00.000Z",
    });
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("badmacro");
  });

  it("fails a build that compiled but rendered citations as [?]", async () => {
    // The authoritative signal, because it inspects what a reader sees rather
    // than which package logged what. A real run passed every log-based check
    // while rendering [?] for all 84 citations.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, {
      ok: true,
      source: ARTIFACTS.finalTex,
      pdf: ARTIFACTS.finalPdf,
      pages: 8,
      errors: [],
      unresolved_citation_marks: 14,
      built_at: "2026-09-02T00:00:00.000Z",
    });
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("14");
    expect(check.detail).toMatch(/not\s+\nsubmission-ready|not submission-ready/);
  });

  it("fails when bibtex could not find a key in any database", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, {
      ok: true,
      source: ARTIFACTS.finalTex,
      pdf: ARTIFACTS.finalPdf,
      pages: 8,
      errors: ["Warning--I didn't find a database entry for \"ghost2024z\""],
      unresolved_citation_marks: 0,
      built_at: "2026-09-02T00:00:00.000Z",
    });
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("ghost2024z");
  });

  it("passes a clean build and reports the page count", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, {
      ok: true,
      source: ARTIFACTS.finalTex,
      pdf: ARTIFACTS.finalPdf,
      pages: 8,
      errors: [],
      built_at: "2026-09-02T00:00:00.000Z",
    });
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("8 page");
  });

  it("reports a malformed build report rather than throwing", async () => {
    const { workspace } = await prepared();
    put(workspace, ARTIFACTS.buildReport, "{not json,,,}");
    expect(() => validators.latexAssembly(workspace)).not.toThrow();
    expect(validators.latexAssembly(workspace).passed).toBe(false);
  });
});

describe("column overflow", () => {
  function reportWith(boxes: Array<{ points: number; lines: string }>) {
    return {
      ok: true,
      source: ARTIFACTS.finalTex,
      pdf: ARTIFACTS.finalPdf,
      pages: 3,
      errors: [],
      unresolved_citation_marks: 0,
      overfull_boxes: boxes,
      built_at: "2026-09-02T00:00:00.000Z",
    };
  }

  it("fails a table that overflows its column", async () => {
    // On a real run a table 41pt too wide for a CVPR column printed on top of
    // the References heading.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, reportWith([{ points: 40.97, lines: "108--116" }]));
    const check = validators.latexAssembly(workspace);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("41pt");
    expect(check.detail).toContain("108--116");
  });

  it("names both real remedies rather than just complaining", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, reportWith([{ points: 40.97, lines: "108--116" }]));
    const detail = validators.latexAssembly(workspace).detail;
    expect(detail).toMatch(/table\*/);
    expect(detail).toMatch(/resizebox|smaller font/);
  });

  it("ignores overflow too small for a reader to see", async () => {
    // A few points is endemic in real papers and invisible in print; failing a
    // run over it would be noise.
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, reportWith([{ points: 3.1, lines: "10--12" }]));
    expect(validators.latexAssembly(workspace).passed).toBe(true);
  });

  it("passes a build with no overflow at all", async () => {
    const { workspace } = await prepared();
    json(workspace, ARTIFACTS.buildReport, reportWith([]));
    expect(validators.latexAssembly(workspace).passed).toBe(true);
  });
});
