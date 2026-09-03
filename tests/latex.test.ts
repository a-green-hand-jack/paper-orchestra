import { describe, expect, it } from "vitest";
import {
  bibKeys,
  citedKeys,
  documentClass,
  includedGraphics,
  unresolvedMarkers,
  usedPackages,
  wordCount,
} from "../src/latex.js";

describe("citedKeys", () => {
  it("finds plain citations", () => {
    expect(citedKeys("text \\cite{smith2024sam} more")).toEqual(["smith2024sam"]);
  });

  it("handles the whole cite family", () => {
    // A manuscript citing correctly via \citep must not be reported as citing
    // nothing, which is exactly how a zero-citation false negative happens.
    const tex = "\\citep{a2024x} \\citet{b2023y} \\citeauthor{c2022z} \\Cite{d2021w}";
    expect(citedKeys(tex)).toEqual(["a2024x", "b2023y", "c2022z", "d2021w"]);
  });

  it("splits comma-separated key lists", () => {
    expect(citedKeys("\\cite{a2024x, b2023y ,c2022z}")).toEqual(["a2024x", "b2023y", "c2022z"]);
  });

  it("skips optional arguments", () => {
    expect(citedKeys("\\citep[see][p.~3]{a2024x}")).toEqual(["a2024x"]);
  });

  it("deduplicates repeated citations", () => {
    expect(citedKeys("\\cite{a2024x} and again \\cite{a2024x}")).toEqual(["a2024x"]);
  });

  it("returns nothing for a manuscript that cites nothing", () => {
    expect(citedKeys("No citations at all.")).toEqual([]);
  });
});

describe("bibKeys", () => {
  it("reads keys from mixed entry types", () => {
    const bib = [
      "@article{smith2024sam,",
      "  title = {A Thing},",
      "}",
      "@inproceedings{ jones2023avs ,",
      "  title = {Another},",
      "}",
    ].join("\n");
    expect(bibKeys(bib)).toEqual(["jones2023avs", "smith2024sam"]);
  });

  it("returns nothing for an empty bibliography", () => {
    expect(bibKeys("")).toEqual([]);
  });
});

describe("includedGraphics", () => {
  it("finds figures with and without options", () => {
    const tex = "\\includegraphics[width=\\linewidth]{figures/overview.png}\n\\includegraphics{a.pdf}";
    expect(includedGraphics(tex)).toEqual(["a.pdf", "figures/overview.png"]);
  });
});

describe("unresolvedMarkers", () => {
  it("finds template placeholders", () => {
    expect(unresolvedMarkers("Title: {{TITLE}}")).toEqual(["{{TITLE}}"]);
  });

  it("finds TODO markers the prompts tell the model to leave", () => {
    const found = unresolvedMarkers("% TODO(paper-orchestra): add citation-supported discussion");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("TODO(paper-orchestra)");
  });

  it("finds the official CVPR abstract scaffold even though it compiles", () => {
    const found = unresolvedMarkers("The ABSTRACT is to be fully justified italicized text, at the top of the left-hand column.");
    expect(found).toEqual(["The ABSTRACT is to be fully justified italicized text"]);
  });

  it("finds the bundled abstract placeholder", () => {
    expect(unresolvedMarkers("\\begin{abstract}\nAbstract here.\n\\end{abstract}")).toEqual(["Abstract here."]);
  });

  it("passes a finished manuscript", () => {
    expect(unresolvedMarkers("\\section{Intro}\nReal prose \\cite{a2024x}.")).toEqual([]);
  });

  it("does not mistake a percentage in prose for a marker", () => {
    expect(unresolvedMarkers("We improve by 52.1\\% over the baseline.")).toEqual([]);
  });
});

describe("documentClass and packages", () => {
  it("reads the class with options", () => {
    expect(documentClass("\\documentclass[10pt,twocolumn,letterpaper]{article}")).toBe("article");
  });

  it("returns null when absent", () => {
    expect(documentClass("no preamble")).toBeNull();
  });

  it("lists packages including comma-separated ones", () => {
    expect(usedPackages("\\usepackage{iclr2025_conference,times}\n\\usepackage[x]{hyperref}")).toEqual(
      ["hyperref", "iclr2025_conference", "times"],
    );
  });
});

describe("wordCount", () => {
  it("counts prose and ignores commands", () => {
    expect(wordCount("\\section{Introduction}\nOne two three four.")).toBe(4);
  });

  it("ignores comment lines", () => {
    expect(wordCount("% this comment has many words in it\nreal prose here")).toBe(3);
  });

  it("keeps an escaped percent in the body", () => {
    expect(wordCount("we gained 5\\% overall")).toBeGreaterThanOrEqual(2);
  });
});
