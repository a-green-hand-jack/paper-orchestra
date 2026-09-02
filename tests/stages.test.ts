import { describe, expect, it } from "vitest";
import {
  COLLABORATIVE_GATES,
  COMMANDS,
  REMEDIATION_ATTEMPTS,
  STAGES,
  TIMEOUTS_MS,
  TITLES,
  isStageId,
  nextStage,
  stageNumber,
} from "../src/stages.js";

describe("the fixed writing plan", () => {
  it("is exactly the five PaperOrchestra stages in order", () => {
    // Locked deliberately: the plan IS this order, and a silent reordering
    // would change what every checkpoint trailer means.
    expect([...STAGES]).toEqual([
      "outline",
      "literature",
      "plotting",
      "section_writing",
      "refinement",
    ]);
  });

  it("gives every stage a command, title, timeout and remediation budget", () => {
    for (const id of STAGES) {
      expect(COMMANDS[id]).toBeTruthy();
      expect(TITLES[id]).toBeTruthy();
      expect(TIMEOUTS_MS[id]).toBeGreaterThan(0);
      expect(REMEDIATION_ATTEMPTS[id]).toBeGreaterThanOrEqual(1);
    }
  });

  it("walks the plan forward and stops at the end", () => {
    expect(nextStage("outline")).toBe("literature");
    expect(nextStage("section_writing")).toBe("refinement");
    expect(nextStage("refinement")).toBeNull();
  });

  it("numbers stages from one", () => {
    expect(stageNumber("outline")).toBe(1);
    expect(stageNumber("refinement")).toBe(5);
  });

  it("recognizes only real stage ids", () => {
    expect(isStageId("literature")).toBe(true);
    expect(isStageId("canonical_drafting")).toBe(false);
  });

  it("gates every stage whose output a human would want to see, except plotting", () => {
    // plotting is verified mechanically by rendering, so a human gate there
    // buys nothing the validators do not already provide.
    expect([...COLLABORATIVE_GATES]).not.toContain("plotting");
    for (const id of COLLABORATIVE_GATES) expect(STAGES).toContain(id);
  });
});
