import { describe, expect, it } from "vitest";
import { OutlineSchema, type Outline } from "../src/artifacts.js";
import {
  anchorNames,
  gateByRelevance,
  matchesAnchor,
  titleHead,
  tokenize,
  topicProfile,
} from "../src/relevance.js";

/**
 * A cut-down version of a real Ref-AVS outline. The titles below are verbatim
 * from four live runs, including the off-domain ones, so these tests exercise
 * the corpus that motivated the gate rather than an invented one.
 */
const OUTLINE: Outline = OutlineSchema.parse({
  plotting_plan: [],
  intro_related_work_plan: {
    introduction_strategy: {
      hook_hypothesis:
        "Promptable image segmentation foundation models offer strong static visual priors, but " +
        "Ref-AVS requires masks that follow objects through 10-second videos and identify targets " +
        "specified by aligned audio and text.",
      problem_gap_hypothesis:
        "Existing audio-visual segmentation methods augmented with text and referring video object " +
        "segmentation methods augmented with audio leave room for a frozen-SAM adaptation.",
      search_directions: ["audio-visual segmentation of sounding objects in video"],
    },
    related_work_strategy: {
      overview: "Audio-visual segmentation and referring video object segmentation baselines.",
      subsections: [
        {
          subsection_title: "Audio-Visual Segmentation with Added Text",
          methodology_cluster: "AVS systems represented by AVSBench and AVSegFormer",
          limitation_search_queries: ["audio visual segmentation temporal consistency limitation"],
        },
        {
          subsection_title: "Referring Video Object Segmentation with Added Audio",
          methodology_cluster: "language-referred video segmentation, ReferFormer and R2-VOS",
          limitation_search_queries: ["referring video object segmentation audio modality"],
        },
      ],
    },
  },
  section_plan: [
    {
      section_title: "Experiments",
      subsections: [
        {
          subsection_title: "Experimental Setup",
          content_bullets: ["Report Jaccard and F-score on the Ref-AVS Seen and Unseen splits."],
          citation_hints: [
            "research paper or technical report introducing 'Segment Anything Model'",
            "research paper or technical report introducing 'PVT-v2'",
            "research paper or technical report introducing 'Mask2Former'",
            "research paper or technical report introducing 'AVSegFormer'",
            "research paper or technical report introducing 'Jaccard Index'",
            "research paper or technical report introducing 'F-score'",
          ],
        },
      ],
    },
  ],
});

function candidate(title: string, venue = "", abstract = "") {
  return { title, venue, abstract };
}

describe("tokenize", () => {
  it("emits adjacent bigrams, which carry the topic that unigrams lose", () => {
    // `segmentation` appears in both `leaf segmentation` and `audio-visual
    // segmentation`; only the bigram distinguishes them.
    expect(tokenize("Audio-Visual Segmentation")).toEqual([
      "audio",
      "visual",
      "segmentation",
      "audio_visual",
      "visual_segmentation",
    ]);
  });

  it("drops stopwords, short tokens and bare numbers", () => {
    expect(tokenize("A Study of the 2024 Model")).toEqual([]);
  });
});

describe("titleHead", () => {
  it("takes the subject, stopping at a colon", () => {
    expect(titleHead("PVT v2: Improved baselines with Pyramid Vision Transformer")).toEqual([
      "pvt",
      "v2",
    ]);
  });

  it("stops at a spaced dash as well as a colon", () => {
    expect(titleHead("AMBER -- Advanced SegFormer for Multi-Band Image Segmentation")).toEqual([
      "amber",
    ]);
  });

  it("keeps the whole title when there is no separator", () => {
    expect(titleHead("Segment Anything")).toEqual(["segment", "anything"]);
  });
});

describe("anchorNames", () => {
  it("recovers the artifact names from the outline's citation hints", () => {
    // The outline prompt mandates the "research paper or technical report
    // introducing '<X>'" wrapper; the anchor is <X>.
    expect(anchorNames(OUTLINE)).toContain("Segment Anything Model");
    expect(anchorNames(OUTLINE)).toContain("PVT-v2");
  });

  it("deduplicates hints repeated across subsections", () => {
    const names = anchorNames(OUTLINE);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("matchesAnchor", () => {
  const anchors = anchorNames(OUTLINE);

  it("matches when the real title is shorter than the hint", () => {
    // The hint says `Segment Anything Model`; the paper is titled `Segment Anything`.
    expect(matchesAnchor("Segment Anything", anchors)).toBe("Segment Anything Model");
  });

  it("matches when the real title is longer than the hint", () => {
    expect(matchesAnchor("Mask2Former for Video Instance Segmentation", anchors)).toBe(
      "Mask2Former",
    );
  });

  it("matches across the hint's punctuation", () => {
    expect(
      matchesAnchor("PVT v2: Improved baselines with Pyramid Vision Transformer", anchors),
    ).toBe("PVT-v2");
  });

  it("rejects a paper that merely applies the artifact", () => {
    // This is the whole point of using the title's head: a derivative paper
    // names the artifact but is not the paper introducing it.
    expect(
      matchesAnchor("Lung Segmentation in Chest X-ray Images using the Segment Anything Model", anchors),
    ).toBeNull();
    expect(
      matchesAnchor("Panoptic Segmentation Using Mask2Former with Swin Transformers", anchors),
    ).toBeNull();
    expect(matchesAnchor("Segment Anything in Glaciology: An initial study", anchors)).toBeNull();
  });

  it("rejects a generic concept paper that shares the hint's words", () => {
    expect(matchesAnchor("Further Generalizations of the Jaccard Index", anchors)).toBeNull();
    expect(matchesAnchor("Fuzzy Jaccard Index: A robust comparison of ordered lists", anchors)).toBeNull();
    expect(matchesAnchor("An intruder from another world: F1-score.", anchors)).toBeNull();
  });

  it("compares whole tokens, so a similar acronym is not a match", () => {
    // Both of these appeared in one real run: GAVS is an audio-visual
    // segmentation method, GAVE is gastric antral vascular ectasia. A
    // substring comparison would confuse SAM with SAMA the same way.
    const withGavs = anchorNames(OUTLINE).concat("GAVS", "SAM");
    expect(matchesAnchor("Gastric Antral Vascular Ectasia (GAVE)", withGavs)).toBeNull();
    expect(matchesAnchor("SAMA: A unified framework", withGavs)).toBeNull();
    expect(matchesAnchor("GAVS: Generalizable audio-visual segmentation", withGavs)).toBe("GAVS");
  });
});

describe("topicProfile", () => {
  it("is built from the outline's own vocabulary", () => {
    const profile = topicProfile(OUTLINE);
    expect(profile.get("audio_visual")).toBeGreaterThan(0);
    expect(profile.get("segmentation")).toBeGreaterThan(0);
    expect(profile.get("gastroenterology")).toBeUndefined();
  });
});

describe("gateByRelevance", () => {
  const POOL = [
    candidate("Ref-AVS: Refer and Segment Objects in Audio-Visual Scenes", "arXiv",
      "We introduce referring audio-visual segmentation over 10-second videos."),
    candidate("AVSegFormer: Audio-Visual Segmentation with Transformer", "arXiv",
      "Audio-visual segmentation with a transformer decoder over video frames."),
    candidate("Language as Queries for Referring Video Object Segmentation", "arXiv",
      "Referring video object segmentation with language queries."),
    candidate("Gastric Antral Vascular Ectasia (GAVE)", "In Clinical Practice",
      "A review of endoscopic management of gastric antral vascular ectasia."),
    candidate("The Effect of Damaging Electric Muscle Contraction on Mitochondrial Health",
      "The FASEB Journal", "Mitochondrial respiration after eccentric contraction in rodents."),
    candidate("Aktivitas Antioksidan Ekstrak Etanol Muntingia calabura", "Jurnal Pharmascience",
      "Antioxidant activity of ethanol extract measured by DPPH assay."),
  ];

  it("drops the off-domain tail and keeps the paper's own neighbourhood", () => {
    const gate = gateByRelevance(POOL, OUTLINE);
    const kept = gate.admitted.map((c) => c.title);

    expect(kept).toContain("Ref-AVS: Refer and Segment Objects in Audio-Visual Scenes");
    expect(kept).toContain("AVSegFormer: Audio-Visual Segmentation with Transformer");
    expect(kept).not.toContain("Gastric Antral Vascular Ectasia (GAVE)");
    expect(kept).not.toContain("Aktivitas Antioksidan Ekstrak Etanol Muntingia calabura");
  });

  it("returns judgements ordered most relevant first", () => {
    const gate = gateByRelevance(POOL, OUTLINE);
    const scores = gate.judgements.map((j) => j.topical);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("keeps a foundational paper whose abstract shares little with the topic", () => {
    // The measured failure this exists to prevent: against a real Ref-AVS
    // paper, `Segment Anything` scores 0.030 and `PVT v2` scores 0.023 --
    // both inside the junk band -- because their abstracts are about a mask
    // data engine and about pyramid backbones. A similarity threshold alone
    // deletes the two citations the manuscript most needs.
    const pool = [
      ...POOL,
      candidate("Segment Anything", "arXiv",
        "We build the largest segmentation dataset to date with over 1 billion masks on 11M images."),
      candidate("PVT v2: Improved baselines with Pyramid Vision Transformer", "Computational Visual Media",
        "We improve the pyramid vision transformer with linear complexity attention and overlapping patch embedding."),
    ];
    const gate = gateByRelevance(pool, OUTLINE);
    const kept = gate.admitted.map((c) => c.title);

    expect(kept).toContain("Segment Anything");
    expect(kept).toContain("PVT v2: Improved baselines with Pyramid Vision Transformer");
    expect(gate.anchorRescued).toBeGreaterThan(0);
  });

  it("records why each entry survived, so a bibliography can be audited", () => {
    const gate = gateByRelevance(POOL, OUTLINE);
    const best = Math.max(...gate.judgements.map((j) => j.topical));

    for (const judgement of gate.judgements) {
      expect(judgement.topical).toBeGreaterThanOrEqual(0);
      expect(judgement.topical).toBeLessThanOrEqual(1);
      // Admission is exactly the stated rule, with nothing else in play.
      expect(judgement.admitted).toBe(
        judgement.topical >= best * 0.1 || judgement.anchor !== null,
      );
    }
    expect(gate.admitted.length + gate.rejected.length).toBe(POOL.length);
  });

  it("admits everything when the threshold is zero, so the gate is opt-out", () => {
    const gate = gateByRelevance(POOL, OUTLINE, { fraction: 0 });
    expect(gate.admitted).toHaveLength(POOL.length);
    expect(gate.rejected).toHaveLength(0);
  });

  it("survives an empty pool rather than dividing by zero", () => {
    const gate = gateByRelevance([], OUTLINE);
    expect(gate.admitted).toEqual([]);
    expect(gate.rejected).toEqual([]);
  });
});
