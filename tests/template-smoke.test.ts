import { copyFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLatex } from "../src/latexbuild.js";
import { templateAdapter } from "../src/venue-catalog.js";
import { templateRoot } from "../src/venues.js";
import { scratchDir } from "./fixtures.js";

const BUNDLED_ADAPTERS = ["cvpr2025", "iclr2025", "nature-portfolio"] as const;

describe("bundled template smoke tests", () => {
  for (const id of BUNDLED_ADAPTERS) {
    it(`${id} compiles from its locked source tree`, async () => {
      const adapter = templateAdapter(id);
      expect(adapter?.source.kind).toBe("bundled");
      if (adapter?.source.kind !== "bundled") return;

      const dir = join(scratchDir("po-template-smoke-"), id);
      cpSync(join(templateRoot(), adapter.source.directory), dir, { recursive: true });
      // TeX treats `template` as a special job name on some installations.
      // The writing pipeline always compiles its generated manuscript instead.
      copyFileSync(join(dir, "template.tex"), join(dir, "smoke.tex"));
      const built = await compileLatex({ cwd: dir, jobName: "smoke" });
      expect(built.ok).toBe(true);
      expect(built.errors).toEqual([]);
    });
  }
});
