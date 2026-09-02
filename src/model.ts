import type { ModelRef } from "./state/schema.js";
import { STAGES, type StageId } from "./stages.js";

/**
 * Parse a `provider/model` reference, optionally with a `:variant` suffix.
 *
 * Being model-agnostic is the reason this project runs on OpenCode at all, so
 * nothing here hardcodes a provider. When no reference is supplied the model is
 * left unset and OpenCode's own configured default applies — guessing a model
 * id that may not exist for the user's provider would be worse than deferring.
 */
export function parseModelRef(ref: string): ModelRef {
  const [core, variant = null] = ref.split(":", 2);
  const at = (core ?? "").indexOf("/");
  if (at <= 0 || at === (core ?? "").length - 1) {
    throw new Error(`invalid model reference "${ref}"; expected provider/model[:variant]`);
  }
  return {
    providerID: (core as string).slice(0, at),
    modelID: (core as string).slice(at + 1),
    variant,
  };
}

export function formatModelRef(model: ModelRef | null): string {
  if (!model) return "opencode-default";
  return model.variant
    ? `${model.providerID}/${model.modelID}:${model.variant}`
    : `${model.providerID}/${model.modelID}`;
}

/**
 * Per-stage model overrides, e.g. `--stage-model literature=openai/gpt-5-mini`.
 * Mechanical stages rarely need the strongest model, and OpenCode selects the
 * model per prompt, so this costs nothing structurally.
 */
export function parseStageModels(entries: readonly string[]): Partial<Record<StageId, ModelRef>> {
  const out: Partial<Record<StageId, ModelRef>> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at <= 0) {
      throw new Error(`invalid --stage-model "${entry}"; expected <stage>=<provider/model>`);
    }
    const stage = entry.slice(0, at);
    if (!(STAGES as readonly string[]).includes(stage)) {
      throw new Error(
        `unknown stage "${stage}" in --stage-model; expected one of ${STAGES.join(", ")}`,
      );
    }
    out[stage as StageId] = parseModelRef(entry.slice(at + 1));
  }
  return out;
}

/** The model a stage should use: its override, else the run default. */
export function modelForStage(
  stage: StageId,
  defaultModel: ModelRef | null,
  overrides: Partial<Record<StageId, ModelRef>>,
): ModelRef | null {
  return overrides[stage] ?? defaultModel;
}
