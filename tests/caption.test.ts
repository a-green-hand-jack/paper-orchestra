import { describe, expect, it } from "vitest";
import { extractCaption } from "../src/controller.js";

/**
 * The caption arrives as prose alongside a fenced script, so extraction has to
 * survive a model that formats its answer in any of the usual ways -- and must
 * not pick up a `# comment` inside the script that happens to say "caption".
 */
describe("extractCaption", () => {
  it("reads a caption on the same line as its label", () => {
    expect(extractCaption("```python\nx=1\n```\nCaption: Accuracy across seeds.")).toBe(
      "Accuracy across seeds.",
    );
  });

  it("reads a caption on the line after a heading", () => {
    expect(extractCaption("```python\nx=1\n```\n## Caption\n\nAccuracy across seeds.")).toBe(
      "Accuracy across seeds.",
    );
  });

  it("strips bold markup a model adds around the label", () => {
    expect(extractCaption("```python\nx=1\n```\n**Caption:** Accuracy across seeds.")).toBe(
      "Accuracy across seeds.",
    );
  });

  it("strips a Figure N prefix, which LaTeX would double", () => {
    // The template numbers figures itself, so a baked-in prefix renders as
    // "Figure 1: Figure 3: ...".
    expect(extractCaption("```python\nx=1\n```\nCaption: Figure 3: Accuracy.")).toBe("Accuracy.");
  });

  it("ignores the word caption inside the script", () => {
    // Without excluding fenced regions this returns the comment's text, and
    // every figure gets a caption written for the code rather than the reader.
    const answer = [
      "```python",
      "# Caption: this comment is not the caption",
      "import matplotlib.pyplot as plt",
      "```",
      "Caption: The real caption.",
    ].join("\n");
    expect(extractCaption(answer)).toBe("The real caption.");
  });

  it("returns empty when the model gave none, so the caller can fall back", () => {
    expect(extractCaption("```python\nx=1\n```")).toBe("");
  });
});
