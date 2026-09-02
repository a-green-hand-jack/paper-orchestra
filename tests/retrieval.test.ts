import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Retrieval end to end with the `bohr` CLI stubbed.
 *
 * The interesting behaviour here is not the HTTP call, it is the bookkeeping
 * around it: which query gets credit for a record two queries both returned,
 * and whether the relevance gate runs before the DOI registries are asked.
 */
const runs: Array<{ query: string; args: string[] }> = [];
let corpus: Record<string, Array<Record<string, unknown>>> = {};

vi.mock("execa", () => ({
  execa: async (_bin: string, args: string[]) => {
    const query = args[2] as string;
    runs.push({ query, args });
    const papers = Object.fromEntries(
      (corpus[query] ?? []).map((paper, at) => [`p${at}`, paper]),
    );
    return { stdout: JSON.stringify({ ok: true, data: { papers } }) };
  },
}));

const { retrieveLiterature } = await import("../src/literature.js");
const { OutlineSchema } = await import("../src/artifacts.js");

const OUTLINE = OutlineSchema.parse({
  intro_related_work_plan: {
    introduction_strategy: {
      hook_hypothesis: "Audio-visual segmentation of sounding objects in video.",
      problem_gap_hypothesis: "Referring audio-visual segmentation over 10-second videos.",
    },
    related_work_strategy: {
      overview: "Audio-visual segmentation baselines.",
      subsections: [{ subsection_title: "Audio-Visual Segmentation" }],
    },
  },
  section_plan: [
    {
      section_title: "Experiments",
      subsections: [
        {
          subsection_title: "Setup",
          citation_hints: ["research paper or technical report introducing 'PVT-v2'"],
        },
      ],
    },
  ],
});

function paper(title: string, over: Record<string, unknown> = {}) {
  return {
    id: title,
    en_title: title,
    en_abstract: `An abstract about ${title}.`,
    publication_name: "arXiv",
    cover_date_start: "2023-01-01",
    doi: "10.0410/synthetic",
    ...over,
  };
}

beforeEach(() => {
  runs.length = 0;
  corpus = {};
});

const BASE = { cutoff: "2026-01", maxCalls: 10, enrich: false as const };

describe("query provenance", () => {
  it("credits every query that returned a record, not just the first", () => {
    // Two queries converging on one paper is evidence that paper is central;
    // crediting only the first would under-count whichever ran second.
    corpus = {
      "audio visual segmentation": [paper("Audio-Visual Segmentation with Semantics")],
      "sounding object segmentation": [paper("Audio-Visual Segmentation with Semantics")],
    };
    return retrieveLiterature({
      ...BASE,
      queries: ["audio visual segmentation", "sounding object segmentation"],
      outline: OUTLINE,
    }).then((result) => {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.matched_queries).toEqual([
        "audio visual segmentation",
        "sounding object segmentation",
      ]);
      expect(result.dropped.duplicate).toBe(1);
    });
  });

  it("reports per-query yield so a barren query can be identified and dropped", async () => {
    // Each LKM call costs a fixed 0.05 CNY. Without per-query yield there is no
    // evidence distinguishing a badly phrased query from a thin corpus.
    corpus = {
      "audio visual segmentation": [paper("Audio-Visual Segmentation with Semantics")],
      "gastric antral vascular ectasia": [paper("Gastric Antral Vascular Ectasia (GAVE)")],
    };
    const result = await retrieveLiterature({
      ...BASE,
      queries: ["audio visual segmentation", "gastric antral vascular ectasia"],
      outline: OUTLINE,
    });

    const barren = result.perQuery.filter((entry) => entry.admitted === 0);
    expect(barren.map((entry) => entry.query)).toEqual(["gastric antral vascular ectasia"]);
    // It did retrieve something; what it retrieved was simply not about this paper.
    expect(barren[0]!.retrieved).toBe(1);
  });
});

describe("the relevance gate inside retrieval", () => {
  it("keeps the paper's neighbourhood and drops the off-domain tail", async () => {
    corpus = {
      q1: [
        paper("Audio-Visual Segmentation with Semantics"),
        paper("AVSegFormer: Audio-Visual Segmentation with Transformer"),
        paper("Gastric Antral Vascular Ectasia (GAVE)", {
          en_abstract: "Endoscopic management of gastric antral vascular ectasia in cirrhosis.",
        }),
        paper("Aktivitas Antioksidan Ekstrak Etanol Muntingia calabura", {
          en_abstract: "Antioxidant activity of an ethanol extract measured by DPPH assay.",
        }),
      ],
    };
    const result = await retrieveLiterature({ ...BASE, queries: ["q1"], outline: OUTLINE });
    const titles = result.candidates.map((c) => c.title);

    expect(titles).toContain("Audio-Visual Segmentation with Semantics");
    expect(titles).not.toContain("Gastric Antral Vascular Ectasia (GAVE)");
    expect(result.dropped.irrelevant).toBeGreaterThan(0);
  });

  it("returns candidates most relevant first, as the writer's prompt promises", async () => {
    corpus = {
      q1: [
        paper("Something largely unrelated to the subject", {
          en_abstract: "A paper about supply chain logistics scheduling.",
        }),
        paper("Audio-Visual Segmentation with Semantics"),
      ],
    };
    const result = await retrieveLiterature({ ...BASE, queries: ["q1"], outline: OUTLINE });
    const scores = result.candidates.map((c) => c.relevance);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("keeps a named backbone whose abstract would otherwise fail the gate", async () => {
    // The measured trap. Alongside genuinely on-topic papers, `PVT v2` and
    // `Segment Anything` score inside the junk band on four real runs, because
    // their abstracts are about pyramid backbones and mask data engines rather
    // than about audio-visual segmentation. They survive only because the
    // outline named them as things the manuscript must cite.
    corpus = {
      q1: [
        paper("Audio-Visual Segmentation with Semantics", {
          en_abstract:
            "Audio-visual segmentation of sounding objects in video with semantic labels, " +
            "referring audio-visual segmentation over 10-second videos.",
        }),
        paper("PVT v2: Improved baselines with Pyramid Vision Transformer", {
          en_abstract: "Linear complexity attention and overlapping patch embedding.",
        }),
      ],
    };
    const result = await retrieveLiterature({ ...BASE, queries: ["q1"], outline: OUTLINE });

    const pvt = result.candidates.find((c) => c.title.startsWith("PVT v2"));
    expect(pvt?.anchor).toBe("PVT-v2");
    expect(result.anchorRescued).toBe(1);

    // And it really was below the bar: the anchor did the work, not the score.
    const best = Math.max(...result.candidates.map((c) => c.relevance));
    expect(pvt!.relevance).toBeLessThan(best * 0.1);
  });

  it("leaves the pool untouched when no outline is supplied", async () => {
    corpus = { q1: [paper("Gastric Antral Vascular Ectasia (GAVE)")] };
    const result = await retrieveLiterature({ ...BASE, queries: ["q1"] });
    expect(result.candidates).toHaveLength(1);
    expect(result.dropped.irrelevant).toBe(0);
  });
});

describe("retrieval budget", () => {
  it("stops at maxCalls even when more queries are supplied", async () => {
    corpus = { a: [paper("A")], b: [paper("B")], c: [paper("C")] };
    const result = await retrieveLiterature({
      ...BASE,
      maxCalls: 2,
      queries: ["a", "b", "c"],
    });
    expect(result.callsMade).toBe(2);
    expect(runs.map((r) => r.query)).toEqual(["a", "b"]);
  });

  it("drops papers published after the cutoff", async () => {
    corpus = { q1: [paper("Future Work", { cover_date_start: "2027-06-01" })] };
    const result = await retrieveLiterature({ ...BASE, cutoff: "2026-01", queries: ["q1"] });
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped.anachronistic).toBe(1);
  });
});
