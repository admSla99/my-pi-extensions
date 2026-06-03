import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Family, FamilyMode, ModelRef, Settings } from "./types.js";

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-prompt-enhancer-settings.json");

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  familyMode: "auto",
  fallbackFamily: "gpt",
  enhancerModel: { mode: "active" },
  defaultTechnique: "general",
  notify: true,
  preserveDraftLanguage: true,
};

export function loadSettings(path: string = SETTINGS_PATH): Settings {
  try {
    const raw = readFileSync(path, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, path: string = SETTINGS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function sanitize(value: unknown): Settings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  return {
    version: 1,
    familyMode: readFamilyMode(value.familyMode),
    fallbackFamily: readFamily(value.fallbackFamily, DEFAULT_SETTINGS.fallbackFamily),
    enhancerModel: readEnhancerModel(value.enhancerModel),
    defaultTechnique:
      typeof value.defaultTechnique === "string" && value.defaultTechnique.trim()
        ? value.defaultTechnique.trim()
        : DEFAULT_SETTINGS.defaultTechnique,
    notify: typeof value.notify === "boolean" ? value.notify : DEFAULT_SETTINGS.notify,
    preserveDraftLanguage:
      typeof value.preserveDraftLanguage === "boolean"
        ? value.preserveDraftLanguage
        : DEFAULT_SETTINGS.preserveDraftLanguage,
  };
}

function readFamilyMode(value: unknown): FamilyMode {
  return value === "auto" || value === "gpt" || value === "claude" ? value : DEFAULT_SETTINGS.familyMode;
}

function readFamily(value: unknown, fallback: Family): Family {
  return value === "gpt" || value === "claude" ? value : fallback;
}

function readEnhancerModel(value: unknown): Settings["enhancerModel"] {
  if (!isRecord(value)) return { mode: "active" };
  if (value.mode === "fixed" && isRecord(value.ref)) {
    const ref = readModelRef(value.ref);
    if (ref) return { mode: "fixed", ref };
  }
  return { mode: "active" };
}

function readModelRef(value: Record<string, unknown>): ModelRef | undefined {
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!provider || !id) return undefined;
  return { provider, id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
