import { describe, expect, it } from "vitest";
import { OutlineSchema } from "../src/artifacts.js";
import { collectQueries, planQueries, tidyQuery } from "../src/queries.js";

const OUTLINE = OutlineSchema.parse({
  plotting_plan: [],
  intro_related_work_plan: {
    introduction_strategy: {
      search_directions: ["broad framing of promptable segmentation"],
    },
    related_work_strategy: {
      subsections: [
        {
          subsection_title: "SAM adapters",
          methodology_cluster: "parameter-efficient adaptation",
          sota_investigation_mission: "find recent adapter methods",
          limitation_search_queries: ["adapter methods fail on temporal consistency"],
        },
      ],
    },
  },
  section_plan: [
    {
      section_title: "Experiments",
      subsections: [
        {
          subsection_title: "Setup",
          citation_hints: ["research paper or technical report introducing 'AdamW'", "Ref-AVS dataset"],
        },
      ],
    },
  ],
});

describe("collectQueries", () => {
  it("puts citation hints first, because they decide citation_integrity", () => {
    // Retrieval has a hard call budget and each call costs money, so the
    // queries that make \\cite keys resolvable must not be crowded out by broad
    // framing queries.
    const queries = collectQueries(OUTLINE);
    expect(queries[0]).toContain("AdamW");
    expect(queries[1]).toContain("Ref-AVS");
  });

  it("puts broad introduction directions last", () => {
    const queries = collectQueries(OUTLINE);
    expect(queries[queries.length - 1]).toContain("broad framing");
  });

  it("includes limitation queries and methodology clusters", () => {
    const joined = collectQueries(OUTLINE).join(" | ");
    expect(joined).toContain("temporal consistency");
    expect(joined).toContain("parameter-efficient adaptation");
  });

  it("deduplicates while preserving priority order", () => {
    const withDupes = OutlineSchema.parse({
      ...OUTLINE,
      intro_related_work_plan: {
        ...OUTLINE.intro_related_work_plan,
        introduction_strategy: { search_directions: ["Ref-AVS dataset", "Ref-AVS  dataset"] },
      },
    });
    const queries = collectQueries(withDupes);
    expect(queries.filter((q) => q.toLowerCase().includes("ref-avs"))).toHaveLength(1);
  });

  it("returns nothing for an outline with no hints or queries", () => {
    expect(collectQueries(OutlineSchema.parse({}))).toEqual([]);
  });
});

describe("tidyQuery", () => {
  it("strips the human-searcher instruction wrapper", () => {
    // The outline prompt mandates this phrasing for anti-hallucination, but the
    // wrapper is noise to a retrieval index.
    expect(tidyQuery("research paper or technical report introducing 'AdamW'")).toBe("AdamW");
  });

  it("strips a leading Find", () => {
    expect(tidyQuery("Find surveys of audio-visual segmentation")).toBe(
      "surveys of audio-visual segmentation",
    );
  });

  it("removes quotes that would confuse the query parser", () => {
    expect(tidyQuery('the "Ref-AVS" dataset')).toBe("the Ref-AVS dataset");
  });

  it("leaves an ordinary query alone", () => {
    expect(tidyQuery("temporal consistency in video segmentation")).toBe(
      "temporal consistency in video segmentation",
    );
  });

  it("bounds length", () => {
    expect(tidyQuery("x".repeat(500)).length).toBe(300);
  });
});

describe("planQueries", () => {
  it("drops generic concepts that spent calls without yielding citable work", () => {
    const outline = OutlineSchema.parse({
      ...OUTLINE,
      section_plan: [
        {
          section_title: "Experiments",
          subsections: [
            {
              subsection_title: "Setup",
              citation_hints: [
                "Jaccard Index metric",
                "F-score metric",
                "AdamW optimizer",
                "Transformer cross-attention",
                "Segment Anything Model",
              ],
            },
          ],
        },
      ],
    });
    const plan = planQueries(outline);
    expect(plan.queries).toContain("Segment Anything Model");
    expect(plan.queries).not.toContain("AdamW");
    expect(plan.queries).not.toContain("Jaccard Index metric");
    expect(plan.decisions.filter((entry) => entry.action === "dropped")).toHaveLength(4);
  });

  it("expands a collided acronym from the outline's own domain context", () => {
    const outline = OutlineSchema.parse({
      ...OUTLINE,
      intro_related_work_plan: {
        ...OUTLINE.intro_related_work_plan,
        related_work_strategy: {
          subsections: [
            {
              subsection_title: "Audio-visual segmentation",
              limitation_search_queries: [
                "GAVS SAM audio visual segmentation multimodal fusion limitation",
              ],
            },
          ],
        },
      },
      section_plan: [
        {
          section_title: "Related Work",
          subsections: [
            {
              subsection_title: "Methods",
              citation_hints: ["research paper or technical report introducing 'GAVS'"],
            },
          ],
        },
      ],
    });
    const plan = planQueries(outline);
    expect(plan.queries[0]).toBe(
      "GAVS SAM audio visual segmentation multimodal fusion limitation",
    );
    expect(plan.decisions[0]).toMatchObject({ action: "contextualized" });
    expect(plan.queries).toHaveLength(2);
  });

  it("does not rewrite required named works", () => {
    const outline = OutlineSchema.parse({
      ...OUTLINE,
      section_plan: [
        {
          section_title: "Related Work",
          subsections: [
            {
              subsection_title: "Foundations",
              citation_hints: ["Segment Anything", "PVT v2", "Mask2Former"],
            },
          ],
        },
      ],
    });
    expect(planQueries(outline).queries.slice(0, 3)).toEqual([
      "Segment Anything",
      "PVT v2",
      "Mask2Former",
    ]);
  });
});
