import { describe, expect, it } from "vitest";
import { formatModelRef, modelForStage, parseModelRef, parseStageModels } from "../src/model.js";

describe("model references", () => {
  it("parses provider and model", () => {
    expect(parseModelRef("openai/gpt-5.6-terra")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: null,
    });
  });

  it("parses a variant suffix", () => {
    expect(parseModelRef("openai/gpt-5.6-terra:medium")).toMatchObject({
      modelID: "gpt-5.6-terra",
      variant: "medium",
    });
  });

  it("keeps slashes that belong to the model id", () => {
    // Provider ids never contain a slash, model ids sometimes do.
    expect(parseModelRef("openrouter/anthropic/claude-3.5")).toMatchObject({
      providerID: "openrouter",
      modelID: "anthropic/claude-3.5",
    });
  });

  it("rejects references with no provider", () => {
    expect(() => parseModelRef("gpt-5.6-terra")).toThrow(/expected provider\/model/);
    expect(() => parseModelRef("/gpt")).toThrow();
    expect(() => parseModelRef("openai/")).toThrow();
  });

  it("renders null as the OpenCode default rather than inventing a model", () => {
    expect(formatModelRef(null)).toBe("opencode-default");
  });

  it("parses per-stage overrides and rejects unknown stages", () => {
    const parsed = parseStageModels(["literature=openai/gpt-5-mini"]);
    expect(parsed.literature).toMatchObject({ modelID: "gpt-5-mini" });
    expect(() => parseStageModels(["drafting=openai/gpt-5"])).toThrow(/unknown stage/);
    expect(() => parseStageModels(["literature"])).toThrow(/expected <stage>=/);
  });

  it("prefers a stage override over the run default", () => {
    const fallback = parseModelRef("openai/gpt-5.6-terra");
    const override = parseModelRef("openai/gpt-5-mini");
    expect(modelForStage("literature", fallback, { literature: override })).toBe(override);
    expect(modelForStage("outline", fallback, { literature: override })).toBe(fallback);
    expect(modelForStage("outline", null, {})).toBeNull();
  });
});
