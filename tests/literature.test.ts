import { describe, expect, it } from "vitest";
import { CandidatesSchema, type Candidate } from "../src/artifacts.js";
import { bibKeys } from "../src/latex.js";
import {
  assignCitationKeys,
  citationKey,
  isResolvableDoi,
  isWithinCutoff,
  normalizePersonName,
  normalizeTitle,
  toBibtex,
  toLatexSafe,
  toCitationMap,
} from "../src/literature.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return CandidatesSchema.parse([
    {
      citation_key: "Ying2025Towards",
      title: "Towards Omnimodal Expressions",
      provider: "bohrium_lkm",
      provider_id: "1157656425887956998",
      retrieved_at: "2026-09-02T00:00:00.000Z",
      authors: ["Kaining Ying", "Henghui Ding"],
      venue: "Computer Vision and Pattern Recognition",
      year: "2025",
      abstract: "An abstract.",
      doi: "10.48550/arXiv.2507.22886",
      ...overrides,
    },
  ])[0] as Candidate;
}

describe("normalizeTitle", () => {
  it("collapses case and punctuation so one paper is one record", () => {
    expect(normalizeTitle("Audio-Visual Segmentation with Semantics")).toBe(
      normalizeTitle("audio visual segmentation with semantics!"),
    );
  });

  it("keeps genuinely different titles apart", () => {
    expect(normalizeTitle("Segment Anything")).not.toBe(normalizeTitle("Segment Everything"));
  });
});

describe("citationKey", () => {
  it("builds Author + Year + two meaningful title words", () => {
    expect(citationKey("Kaining Ying | Henghui Ding", "2025", "Towards Omnimodal Expressions")).toBe(
      "Ying2025TowardsOmnimodal",
    );
  });

  it("skips stopwords when picking title words", () => {
    expect(citationKey("Jane Roe", "2024", "A Study of the Thing")).toBe("Roe2024Thing");
  });

  it("falls back to Unknown when LKM returns no authors", () => {
    // LKM leaves `authors` empty far more often than Semantic Scholar did, so
    // this path is load-bearing rather than defensive.
    expect(citationKey("", "2024", "Audio Visual Segmentation")).toBe(
      "Unknown2024AudioVisual",
    );
  });

  it("falls back to 2024 when the year is unknown", () => {
    expect(citationKey("Jane Roe", null, "Some Paper")).toBe("Roe2024SomePaper");
  });

  it("falls back to Paper when the title is all stopwords", () => {
    expect(citationKey("Jane Roe", "2024", "The A An Of")).toBe("Roe2024Paper");
  });

  it("strips non-letters from the author name", () => {
    expect(citationKey("Jean-Luc O'Brien", "2024", "Deep Nets")).toBe("Obrien2024DeepNets");
  });
});

describe("isWithinCutoff", () => {
  it("accepts a paper published before the cutoff month", () => {
    expect(isWithinCutoff("2024-10-16", "2024-11")).toBe(true);
  });

  it("rejects a paper published after the cutoff year", () => {
    // LKM has no date filter flag and its corpus contains papers well past any
    // cutoff, so without this a 2026 paper gets cited as prior work by a
    // manuscript targeting a 2025 venue.
    expect(isWithinCutoff("2026-04-27", "2024-11")).toBe(false);
    expect(isWithinCutoff("2025-07-30", "2024-11")).toBe(false);
  });

  it("rejects a later month within the cutoff year", () => {
    expect(isWithinCutoff("2024-12-01", "2024-11")).toBe(false);
  });

  it("accepts the cutoff month itself", () => {
    expect(isWithinCutoff("2024-11-30", "2024-11")).toBe(true);
  });

  it("keeps a paper whose date is unknown rather than guessing", () => {
    expect(isWithinCutoff(null, "2024-11")).toBe(true);
    expect(isWithinCutoff("", "2024-11")).toBe(true);
  });

  it("accepts everything when no cutoff is set", () => {
    expect(isWithinCutoff("2030-01-01", "")).toBe(true);
  });
});

describe("toBibtex", () => {
  it("emits a key the LaTeX reader can resolve", () => {
    const bib = toBibtex([candidate()]);
    expect(bibKeys(bib)).toEqual(["Ying2025Towards"]);
  });

  it("uses @article for a journal venue and @inproceedings otherwise", () => {
    expect(toBibtex([candidate({ venue: "International Journal of Computer Vision" })])).toContain(
      "@article{",
    );
    expect(toBibtex([candidate({ venue: "Computer Vision and Pattern Recognition" })])).toContain(
      "@inproceedings{",
    );
  });

  it("joins authors with `and`, as BibTeX expects", () => {
    expect(toBibtex([candidate()])).toContain("author = {Kaining Ying and Henghui Ding}");
  });

  it("carries the doi so an entry stays auditable", () => {
    expect(toBibtex([candidate()])).toContain("doi = {10.48550/arXiv.2507.22886}");
  });

  it("escapes braces rather than dropping them", () => {
    // Escaping is strictly safer than stripping: an unbalanced brace cannot
    // break the entry, and the character survives into the rendered reference.
    expect(toBibtex([candidate({ title: "A {Braced} Title" })])).toContain(
      "title = {A \\{Braced\\} Title}",
    );
  });

  it("omits an author field entirely when LKM gave none", () => {
    expect(toBibtex([candidate({ authors: [] })])).not.toContain("author =");
  });
});

describe("toCitationMap", () => {
  it("is keyed by citation key and carries the abstract as evidence", () => {
    const map = toCitationMap([candidate()]);
    expect(Object.keys(map)).toEqual(["Ying2025Towards"]);
    expect(map.Ying2025Towards).toMatchObject({ abstract: "An abstract.", year: "2025" });
  });

  it("agrees with the bibliography, so citation_integrity can pass", () => {
    const candidates = [candidate(), candidate({ citation_key: "Zhou2024Audio", title: "Other" })];
    expect(Object.keys(toCitationMap(candidates)).sort()).toEqual(bibKeys(toBibtex(candidates)));
  });
});

describe("normalizePersonName", () => {
  it("flips DataCite's Family, Given into Given Family", () => {
    // The citation key takes the last whitespace token as the surname, so
    // leaving "Seon, Juhyeong" alone produced the key `Juhyeong2024...`.
    expect(normalizePersonName("Seon, Juhyeong")).toBe("Juhyeong Seon");
  });

  it("leaves an already-natural name alone", () => {
    expect(normalizePersonName("Alexander Kirillov")).toBe("Alexander Kirillov");
  });

  it("keeps a generational suffix in place rather than treating it as a given name", () => {
    expect(normalizePersonName("King, Jr.")).toBe("King, Jr.");
  });

  it("keeps an organization name intact", () => {
    expect(normalizePersonName("OpenAI")).toBe("OpenAI");
  });

  it("yields a citation key built from the surname", () => {
    expect(citationKey(normalizePersonName("Seon, Juhyeong"), "2024", "Extending Segment Anything")).toBe(
      "Seon2024ExtendingSegment",
    );
  });
});

describe("isResolvableDoi", () => {
  it("rejects the synthetic prefix LKM mints for records with no real doi", () => {
    expect(isResolvableDoi("10.0410/cata/d7f54a7d2de72c0297f14915908b6d7f")).toBe(false);
  });

  it("accepts real publisher and arXiv dois", () => {
    expect(isResolvableDoi("10.1109/tmm.2024.3394682")).toBe(true);
    expect(isResolvableDoi("10.48550/arxiv.2304.02643")).toBe(true);
  });

  it("rejects an empty doi", () => {
    expect(isResolvableDoi("")).toBe(false);
  });
});

describe("assignCitationKeys", () => {
  function record(over: Record<string, unknown> = {}) {
    return {
      title: "Segment Anything",
      provider: "bohrium_lkm" as const,
      provider_id: "x",
      retrieved_at: "2026-09-02T00:00:00.000Z",
      authors: ["Alexander Kirillov"],
      venue: "arXiv",
      year: "2023",
      abstract: "a",
      doi: "10.48550/arxiv.2304.02643",
      matched_queries: ["segment anything"],
      relevance: 0,
      anchor: null,
      ...over,
    };
  }

  it("de-collides with a, b, c suffixes", () => {
    const keyed = assignCitationKeys([record(), record({ title: "Segment Anything!" }), record({ title: "Segment  Anything" })]);
    const keys = keyed.map((k) => k.citation_key).sort();
    expect(keys).toEqual(["Kirillov2023SegmentAnything", "Kirillov2023SegmentAnythinga", "Kirillov2023SegmentAnythingb"]);
  });

  it("is deterministic across runs over the same corpus", () => {
    const input = [record({ title: "B Paper" }), record({ title: "A Paper" })];
    const first = assignCitationKeys(input).map((k) => `${k.title}:${k.citation_key}`);
    const second = assignCitationKeys([...input].reverse()).map((k) => `${k.title}:${k.citation_key}`);
    expect(first).toEqual(second);
  });
});

describe("toLatexSafe", () => {
  it("escapes the specials that break a build", () => {
    // An LKM doi like 10.1007/...-4_18 produces "! Missing $ inserted."
    expect(toLatexSafe("10.1007/978-3-030-53736-4_18")).toBe("10.1007/978-3-030-53736-4\\_18");
    expect(toLatexSafe("R&D at 50%")).toBe("R\\&D at 50\\%");
    expect(toLatexSafe("cost $5 #1")).toBe("cost \\$5 \\#1");
  });

  it("escapes tilde and caret with their text commands", () => {
    expect(toLatexSafe("a~b")).toBe("a\\textasciitilde{}b");
    expect(toLatexSafe("x^2")).toBe("x\\textasciicircum{}2");
  });

  it("folds accents to base letters, since the templates load no fontenc", () => {
    // The conference templates are digest-locked inputs we must not modify, so
    // the bibliography has to arrive already typesettable.
    expect(toLatexSafe("Michał Spytkowski")).toBe("Michal Spytkowski");
    expect(toLatexSafe("Kwaśnicka")).toBe("Kwasnicka");
    expect(toLatexSafe("Schrödinger")).toBe("Schrodinger");
  });

  it("normalizes typographic dashes and quotes", () => {
    expect(toLatexSafe("audio–visual")).toBe("audio-visual");
    expect(toLatexSafe("“quoted”")).toBe('"quoted"');
  });

  it("drops characters with no Latin form rather than emitting them", () => {
    // pdflatex reports "Unicode character not set up for use with LaTeX" and
    // the build dies.
    expect(toLatexSafe("Иванов")).toBe("");
  });

  it("removes stray backslashes that would start a command", () => {
    expect(toLatexSafe("a\\badmacro b")).not.toContain("\\b");
  });
});

describe("bibtex safety on real-world metadata", () => {
  function candidateWith(authors: string[], title: string, doi: string) {
    return CandidatesSchema.parse([
      {
        citation_key: "Test2024Thing",
        title,
        provider: "bohrium_lkm",
        provider_id: "x",
        retrieved_at: "2026-09-02T00:00:00.000Z",
        authors,
        venue: "Journal of Things",
        year: "2024",
        abstract: "a",
        doi,
      },
    ])[0] as Candidate;
  }

  it("omits an author list that folds away entirely", () => {
    // Rendering ". ." as an author is worse than omitting the field.
    const bib = toBibtex([candidateWith(["Е. М. Иванов"], "A Title", "10.1/x")]);
    expect(bib).not.toContain("author =");
    expect(bib).not.toContain(". .");
  });

  it("keeps the Latin authors and drops only the unrenderable ones", () => {
    const bib = toBibtex([candidateWith(["Jane Roe", "Иванов"], "A Title", "10.1/x")]);
    expect(bib).toContain("author = {Jane Roe}");
  });

  it("produces a bibliography with no characters pdflatex would reject", () => {
    const bib = toBibtex([
      candidateWith(["Michał Kwaśnicka"], "R&D of 50% x_1", "10.1007/978-3-030-53736-4_18"),
    ]);
    expect(/[^\x20-\x7e\n]/.test(bib)).toBe(false);
    expect(bib).toContain("\\_18");
    expect(bib).toContain("\\&");
  });
});
