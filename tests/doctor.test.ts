import { describe, expect, it } from "vitest";
import { listOpencodeProviders, opencodeVersion, runDoctor } from "../src/doctor.js";

describe("doctor", () => {
  it("reports node, opencode and the LaTeX toolchain as requirements", async () => {
    const { checks } = await runDoctor();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node>=20");
    expect(names).toContain("opencode");
    expect(names).toContain("pdflatex");
    expect(names).toContain("bibtex");
  });

  it("keeps plotting and visual review as probes, so their absence is not fatal", async () => {
    // A machine with no matplotlib can still write a paper with plotting off;
    // failing there would be a false alarm.
    const { probes } = await runDoctor();
    const names = probes.map((p) => p.name);
    expect(names.some((n) => n.includes("matplotlib"))).toBe(true);
    expect(names.some((n) => n.includes("pdftoppm"))).toBe(true);
  });

  it("never lets a probe influence the pass/fail verdict", async () => {
    const { checks, ok } = await runDoctor();
    expect(ok).toBe(checks.every((c) => c.passed));
  });

  it("lists provider names only, never credential values", async () => {
    const providers = await listOpencodeProviders();
    for (const name of providers) {
      expect(name).toMatch(/^[\w.-]+$/);
      expect(name.length).toBeLessThan(64);
    }
  });

  it("memoizes the opencode version", async () => {
    expect(await opencodeVersion()).toBe(await opencodeVersion());
  });
});
