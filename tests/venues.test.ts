import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledVenues, resolveTemplate, templateRoot } from "../src/venues.js";
import { scratchDir } from "./fixtures.js";

/**
 * `--template` accepts a venue name so the CLI works when installed globally
 * and run from the materials directory, where a relative `templates/cvpr2025`
 * means nothing.
 */
describe("bundledVenues", () => {
  it("finds the venues shipped with the package", () => {
    expect(bundledVenues()).toContain("cvpr2025");
    expect(bundledVenues()).toContain("iclr2025");
  });

  it("lists only directories that really hold a template", () => {
    for (const venue of bundledVenues()) {
      expect(() => resolveTemplate(venue)).not.toThrow();
    }
  });
});

describe("resolveTemplate", () => {
  it("resolves a bare venue name against the bundled templates", () => {
    expect(resolveTemplate("cvpr2025")).toBe(join(templateRoot(), "cvpr2025"));
  });

  it("names the alternatives when a venue does not exist", () => {
    // The message is the whole value of failing here rather than deeper in.
    expect(() => resolveTemplate("neurips2099")).toThrow(/Available: cvpr2025, iclr2025/);
  });

  it("accepts a path to a template of your own", () => {
    const dir = scratchDir("po-tpl-");
    writeFileSync(join(dir, "template.tex"), "\\documentclass{article}");
    expect(resolveTemplate(dir)).toBe(dir);
  });

  it("treats a dotted or slashed value as a path, not a venue", () => {
    // So a local ./cvpr2025 cannot silently shadow the bundled venue.
    expect(() => resolveTemplate("./cvpr2025")).toThrow(/no such template directory/);
  });

  it("rejects a directory that is not a template, saying why", () => {
    const dir = scratchDir("po-empty-");
    mkdirSync(join(dir, "sub"), { recursive: true });
    expect(() => resolveTemplate(dir)).toThrow(/no template\.tex/);
  });
});
