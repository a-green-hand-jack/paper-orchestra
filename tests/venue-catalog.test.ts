import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CCF_A_VENUES,
  TEMPLATE_ADAPTERS,
  assertVenueCatalog,
  manualCcfTemplateAdapter,
  manualMathTemplateAdapterForId,
  templateAdapter,
} from "../src/venue-catalog.js";
import { adaptVenueKit, manualCcfAdapter } from "../src/venue-install.js";
import { resolveTemplate, templateRoot } from "../src/venues.js";
import { scratchDir } from "./fixtures.js";

describe("venue catalog", () => {
  it("contains each CCF-A conference exactly once", () => {
    expect(() => assertVenueCatalog()).not.toThrow();
    expect(CCF_A_VENUES).toHaveLength(58);
    expect(new Set(CCF_A_VENUES.map((venue) => venue.key)).size).toBe(58);
    for (const venue of CCF_A_VENUES) {
      expect(venue.authoringResourceUrl).toMatch(/^https:\/\//);
      expect(venue.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(CCF_A_VENUES.find((venue) => venue.key === "usenix-atc")?.lifecycle).toBe("retired");
    expect(CCF_A_VENUES.map((venue) => venue.key)).toContain("ijcai");
    expect(CCF_A_VENUES.map((venue) => venue.key)).not.toContain("iclr");
  });

  it("keeps current official-download adapters immutable and checksum pinned", () => {
    for (const id of ["cvpr2026", "iclr2026"]) {
      const adapter = templateAdapter(id);
      expect(adapter?.source.kind).toBe("official-archive");
      if (adapter?.source.kind === "official-archive") {
        expect(adapter.source.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(adapter.source.entrypoint).toMatch(/\.tex$/);
      }
    }
    expect(templateAdapter("cvpr2026")?.source).toMatchObject({
      kind: "official-archive",
      sourceRoot: "author-kit-CVPR2026-v1-latex-",
      entrypoint: "main.tex",
    });
  });

  it("documents every non-bundled adapter rather than pretending it is installed", () => {
    const external = TEMPLATE_ADAPTERS.filter((adapter) => adapter.source.kind !== "bundled");
    expect(external.length).toBeGreaterThan(0);
    for (const adapter of external) {
      expect(adapter.authorInstructionsUrl).toMatch(/^https:\/\//);
      expect(adapter.licenseStatus).not.toBe("redistributable");
      expect(adapter.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps mathematics adapters versioned beyond the current edition", () => {
    for (const id of ["isit2027", "colt2027", "aistats2027"]) {
      const adapter = manualMathTemplateAdapterForId(id);
      expect(adapter?.id).toBe(id);
      expect(adapter?.source.kind).toBe("manual");
      expect(adapter?.year).toBe(2027);
    }
  });

  it("records the per-journal Nature and Science-family submission paths", () => {
    const root = templateRoot();
    const nature = JSON.parse(readFileSync(join(root, "nature-portfolio", "journals.json"), "utf8")) as {
      journals: Array<{ id: string; author_instructions_url: string }>;
    };
    const science = JSON.parse(readFileSync(join(root, "science-family", "manifest.json"), "utf8")) as {
      journals: Array<{ id: string; author_instructions_url: string }>;
    };
    expect(nature.journals.map((journal) => journal.id)).toEqual([
      "nature",
      "nature-communications",
      "scientific-reports",
    ]);
    expect(science.journals).toHaveLength(6);
    for (const journal of [...nature.journals, ...science.journals]) {
      expect(journal.author_instructions_url).toMatch(/^https:\/\//);
    }
  });
});

describe("external venue adapter", () => {
  it("requires a versioned CCF-A id for a manually downloaded kit", () => {
    expect(manualCcfAdapter("fast2026", "fast", 2026)).toEqual({ venueKey: "fast", year: 2026 });
    expect(() => manualCcfAdapter("fast", "fast", 2026)).toThrow(/fast2026/);
  });

  it("gives every CCF-A identity a versioned official-kit normalization path", () => {
    for (const venue of CCF_A_VENUES) {
      const id = `${venue.key.replace(/-/g, "")}2025`;
      expect(manualCcfAdapter(id, venue.key, 2025)).toEqual({ venueKey: venue.key, year: 2025 });
      const adapter = manualCcfTemplateAdapter(venue.key, 2025);
      expect(adapter.id).toBe(id);
      expect(adapter.source.kind).toBe("manual");
      expect(adapter.authorInstructionsUrl).toBe(venue.authoringResourceUrl);
    }
  });

  it("normalizes an official kit without flattening nested support files", () => {
    const source = scratchDir("po-official-kit-");
    mkdirSync(join(source, "sec"));
    writeFileSync(join(source, "main.tex"), "\\documentclass{article}\\input{sec/intro}");
    writeFileSync(join(source, "sec", "intro.tex"), "Nested support file.");
    writeFileSync(join(source, "official.sty"), "% official style\n");
    const destination = join(scratchDir("po-adapted-kit-"), "fast2026");

    const installed = adaptVenueKit({
      id: "fast2026",
      sourceDirectory: source,
      sourceUrl: "https://www.usenix.org/conference/fast26/call-for-papers",
      destination,
      entrypoint: "main.tex",
      adapter: manualCcfTemplateAdapter("fast", 2026),
      venueKey: "fast",
      year: 2026,
    });

    expect(installed.id).toBe("fast2026");
    expect(readFileSync(join(destination, "template.tex"), "utf8")).toContain("sec/intro");
    expect(existsSync(join(destination, "sec", "intro.tex"))).toBe(true);
    expect(readFileSync(join(destination, "template-metadata.json"), "utf8")).toContain('"venue_key": "fast"');
    expect(readFileSync(join(destination, "template-metadata.json"), "utf8")).toContain('"adapted_at"');
    expect(readFileSync(join(destination, "template-metadata.json"), "utf8")).toContain('"constraints"');
    expect(readFileSync(join(destination, "template-metadata.json"), "utf8")).toContain('"source_url"');
    expect(readFileSync(join(destination, "guidelines.md"), "utf8")).toContain("USENIX");
  });

  it("shows an install command instead of treating a missing CVPR 2026 kit as bundled", () => {
    expect(() => resolveTemplate("cvpr2026")).toThrow(/templates install cvpr2026/);
  });
});
