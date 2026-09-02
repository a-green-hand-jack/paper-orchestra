import { describe, expect, it } from "vitest";
import { OutlineSchema } from "../src/artifacts.js";
import { collectQueries, tidyQuery } from "../src/queries.js";

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
