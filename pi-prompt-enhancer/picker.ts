import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Settings, Template } from "./types.js";

export interface PickResult {
  template: Template;
  source: "keyword" | "manual" | "default";
}

/**
 * Try to pick a template from the draft using keyword matching.
 * If no keyword matches, fall back to a UI picker (or the configured default if UI is unavailable).
 */
export async function pickTemplate(
  ctx: ExtensionContext,
  templates: Template[],
  settings: Settings,
  draft: string
): Promise<PickResult | undefined> {
  if (templates.length === 0) return undefined;

  const byKeyword = matchByKeyword(templates, draft);
  if (byKeyword) {
    return { template: byKeyword, source: "keyword" };
  }

  if (ctx.hasUI) {
    const chosen = await showPicker(ctx, templates, settings.defaultTechnique);
    if (chosen) {
      return { template: chosen, source: "manual" };
    }
    return undefined; // user cancelled
  }

  const fallback = findById(templates, settings.defaultTechnique) ?? templates[0];
  return fallback ? { template: fallback, source: "default" } : undefined;
}

/**
 * Find the first template whose keyword appears as a whole word in the draft.
 * Templates are scanned in ID order so behavior is deterministic.
 */
export function matchByKeyword(templates: Template[], draft: string): Template | undefined {
  const lower = draft.toLowerCase();
  for (const tpl of templates) {
    for (const keyword of tpl.keywords) {
      if (!keyword) continue;
      // Word-boundary match for multi-word keywords too (escape any regex metachars).
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i");
      if (pattern.test(lower)) {
        return tpl;
      }
    }
  }
  return undefined;
}

async function showPicker(
  ctx: ExtensionContext,
  templates: Template[],
  defaultId: string
): Promise<Template | undefined> {
  // Surface the configured default first so it's a single Enter away.
  const ordered = orderWithDefaultFirst(templates, defaultId);
  const labels = ordered.map((tpl) => formatLabel(tpl));
  const labelToTemplate = new Map(labels.map((label, idx) => [label, ordered[idx]!]));

  const selected = await ctx.ui.select("Pick prompt technique", labels);
  if (!selected) return undefined;
  return labelToTemplate.get(selected);
}

function orderWithDefaultFirst(templates: Template[], defaultId: string): Template[] {
  const idx = templates.findIndex((tpl) => tpl.id === defaultId);
  if (idx <= 0) return templates;
  const copy = templates.slice();
  const [chosen] = copy.splice(idx, 1);
  if (chosen) copy.unshift(chosen);
  return copy;
}

function formatLabel(tpl: Template): string {
  if (tpl.keywords.length === 0) return tpl.name;
  const preview = tpl.keywords.slice(0, 4).join(", ");
  const more = tpl.keywords.length > 4 ? "…" : "";
  return `${tpl.name}   — ${preview}${more}`;
}

export function findById(templates: Template[], id: string): Template | undefined {
  return templates.find((tpl) => tpl.id === id);
}
