import type { Api, Model } from "@earendil-works/pi-ai";
import type { Family, Settings } from "./types.js";

/**
 * Resolve the rewrite family for the current draft.
 *
 * Order:
 *   1. user override in settings (settings.familyMode = "gpt" | "claude")
 *   2. classification from the active model's provider/id
 *   3. settings.fallbackFamily
 */
export function resolveFamily(settings: Settings, activeModel: Model<Api> | undefined): Family {
  if (settings.familyMode !== "auto") {
    return settings.familyMode;
  }
  if (activeModel) {
    const detected = classifyModel(activeModel);
    if (detected) return detected;
  }
  return settings.fallbackFamily;
}

/** Returns the family for a known provider/id, or undefined if we don't recognize it. */
export function classifyModel(model: Model<Api>): Family | undefined {
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();

  if (provider === "anthropic" || id.startsWith("claude")) return "claude";
  // Moonshot / Kimi-style models follow Claude-style prompting conventions.
  if (provider === "moonshot" || id.includes("kimi")) return "claude";
  if (provider === "openai" || provider === "openai-codex") return "gpt";
  if (id.startsWith("gpt") || /^o[1-9]/.test(id)) return "gpt";

  return undefined;
}
