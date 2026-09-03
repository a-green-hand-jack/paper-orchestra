import { describe, expect, it } from "vitest";
import { OutlineSchema } from "../src/artifacts.js";

describe("outline artifact normalization", () => {
  it("normalizes model-produced string subsection shorthand into the locked object shape", () => {
    const outline = OutlineSchema.parse({
      intro_related_work_plan: {
        related_work_strategy: { subsections: ["2.1 Audio-Visual Segmentation"] },
      },
      section_plan: [
        { section_title: "Related Work", subsections: ["2.1 Audio-Visual Segmentation"] },
      ],
    });

    expect(outline.intro_related_work_plan.related_work_strategy.subsections).toMatchObject([
      { subsection_title: "2.1 Audio-Visual Segmentation" },
    ]);
    expect(outline.section_plan[0]?.subsections).toMatchObject([
      { subsection_title: "2.1 Audio-Visual Segmentation", content_bullets: [] },
    ]);
  });
});
