import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { enhanceDraft } from "./enhance.js";
import { resolveFamily } from "./family.js";
import { findById, pickTemplate, type PickResult } from "./picker.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";
import { ensureSeedTemplates, loadTemplates, TEMPLATES_DIR } from "./templates.js";
import type { Family, ModelRef, Settings, Template } from "./types.js";

const COMMAND = "pe";
const SHORTCUT = "alt+e";
const HELP = [
  `/${COMMAND}                       Enhance the current editor draft`,
  `/${COMMAND} undo                  Restore the previous draft`,
  `/${COMMAND} status                Show current configuration`,
  `/${COMMAND} list                  List discovered templates`,
  `/${COMMAND} reload                Re-read templates from disk`,
  `/${COMMAND} pick                  Force the picker (skip keyword auto-match)`,
  `/${COMMAND} family auto|gpt|claude`,
  `/${COMMAND} fallback gpt|claude`,
  `/${COMMAND} default <id>          Default template when no keyword matches`,
  `/${COMMAND} model active          Use the current session model for rewriting`,
  `/${COMMAND} model fixed <provider>/<id>`,
  `/${COMMAND} notify on|off`,
  `/${COMMAND} language on|off       Preserve the draft's natural language in the rewrite`,
  `/${COMMAND} reset                 Restore default settings`,
].join("\n");

/** Per-process state. */
interface Runtime {
  settings: Settings;
  templates: Template[];
  templateErrors: string[];
  previousDraft: string | undefined;
  busy: boolean;
}

export default function piPromptEnhancer(pi: ExtensionAPI): void {
  const runtime: Runtime = {
    settings: { ...DEFAULT_SETTINGS },
    templates: [],
    templateErrors: [],
    previousDraft: undefined,
    busy: false,
  };

  const refresh = (): void => {
    runtime.settings = loadSettings();
    ensureSeedTemplates();
    const result = loadTemplates();
    runtime.templates = result.templates;
    runtime.templateErrors = result.errors;
  };

  pi.on("session_start", (_event, ctx) => {
    refresh();
    if (runtime.templateErrors.length > 0) {
      ctx.ui.notify(`pi-prompt-enhancer: skipped ${runtime.templateErrors.length} bad template(s).`, "warning");
    }
  });

  // Refresh on tree navigation/switch so disk edits between sessions show up.
  pi.on("session_tree", () => refresh());

  pi.registerCommand(COMMAND, {
    description: "Enhance the current editor prompt in-place",
    handler: async (args, ctx) => {
      await handleCommand(args, ctx, runtime);
    },
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Enhance the current editor prompt",
    handler: async (ctx) => {
      await runEnhance(ctx, runtime, { forcePicker: false });
    },
  });
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";

  switch (sub) {
    case "":
      return runEnhance(ctx, runtime, { forcePicker: false });
    case "pick":
      return runEnhance(ctx, runtime, { forcePicker: true });
    case "undo":
      return undoLast(ctx, runtime);
    case "status":
      return showStatus(ctx, runtime);
    case "list":
      return listTemplates(ctx, runtime);
    case "reload": {
      runtime.settings = loadSettings();
      const result = loadTemplates();
      runtime.templates = result.templates;
      runtime.templateErrors = result.errors;
      ctx.ui.notify(
        `Reloaded ${runtime.templates.length} template(s)${result.errors.length ? `, ${result.errors.length} error(s)` : ""}.`,
        result.errors.length ? "warning" : "info"
      );
      return;
    }
    case "help":
      ctx.ui.notify(HELP, "info");
      return;
    case "reset":
      saveSettings({ ...DEFAULT_SETTINGS });
      runtime.settings = { ...DEFAULT_SETTINGS };
      ctx.ui.notify("Settings reset to defaults.", "info");
      return;
    case "family":
      return setFamilyMode(ctx, runtime, parts[1] ?? "");
    case "fallback":
      return setFallback(ctx, runtime, parts[1] ?? "");
    case "default":
      return setDefaultTemplate(ctx, runtime, parts[1] ?? "");
    case "model":
      return setEnhancerModel(ctx, runtime, parts.slice(1));
    case "notify":
      return setNotify(ctx, runtime, parts[1] ?? "");
    case "language":
    case "lang":
      return setPreserveLanguage(ctx, runtime, parts[1] ?? "");
    default:
      ctx.ui.notify(`Unknown subcommand: ${sub}\n\n${HELP}`, "warning");
  }
}

interface RunEnhanceOptions {
  forcePicker: boolean;
}

async function runEnhance(ctx: ExtensionContext, runtime: Runtime, opts: RunEnhanceOptions): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("pi-prompt-enhancer needs interactive TUI mode to read the editor.", "warning");
    return;
  }
  if (runtime.busy) {
    ctx.ui.notify("pi-prompt-enhancer is already running.", "info");
    return;
  }
  if (runtime.templates.length === 0) {
    ctx.ui.notify(`No templates found in ${TEMPLATES_DIR}. Run /pe reload after fixing.`, "warning");
    return;
  }

  const draft = ctx.ui.getEditorText().trim();
  if (!draft) {
    ctx.ui.notify("Editor is empty — nothing to enhance.", "info");
    return;
  }

  let pick: PickResult | undefined;
  if (opts.forcePicker) {
    const chosen = await showManualPicker(ctx, runtime);
    if (!chosen) return;
    pick = { template: chosen, source: "manual" };
  } else {
    pick = await pickTemplate(ctx, runtime.templates, runtime.settings, draft);
  }
  if (!pick) {
    ctx.ui.notify("No template chosen — leaving draft unchanged.", "info");
    return;
  }

  runtime.busy = true;
  try {
    const refined = await runWithLoader(ctx, `Rewriting with ${pick.template.id}…`, async (signal) => {
      const result = await enhanceDraft(ctx, runtime.settings, pick!.template, draft, signal);
      return result.refined;
    });
    if (refined === null) {
      ctx.ui.notify("Enhancement cancelled.", "info");
      return;
    }
    runtime.previousDraft = draft;
    ctx.ui.setEditorText(refined);

    if (runtime.settings.notify) {
      const family = resolveFamily(runtime.settings, ctx.model);
      const source = pick.source === "keyword" ? "keyword match" : pick.source === "manual" ? "picker" : "default";
      ctx.ui.notify(`Enhanced with ${pick.template.id} (${family}, via ${source}).`, "info");
    }
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  } finally {
    runtime.busy = false;
  }
}

/**
 * Wrap a task in BorderedLoader so the user can cancel with Esc/Ctrl+C.
 * Returns the task's value, or `null` if the user aborted.
 */
async function runWithLoader<T>(
  ctx: ExtensionContext,
  message: string,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T | null> {
  let captured: T | null = null;
  let taskError: Error | undefined;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => done(undefined);

    void task(loader.signal)
      .then((value) => {
        if (!loader.signal.aborted) {
          captured = value;
          done(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!loader.signal.aborted) {
          taskError = err instanceof Error ? err : new Error(String(err));
        }
        done(undefined);
      });

    return loader;
  });

  if (taskError) throw taskError;
  return captured;
}

async function showManualPicker(ctx: ExtensionContext, runtime: Runtime): Promise<Template | undefined> {
  const labels = runtime.templates.map((tpl) => tpl.id);
  const selected = await ctx.ui.select("Pick prompt technique", labels);
  if (!selected) return undefined;
  return findById(runtime.templates, selected);
}

async function undoLast(ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Undo needs interactive TUI mode.", "warning");
    return;
  }
  if (!runtime.previousDraft) {
    ctx.ui.notify("Nothing to undo.", "info");
    return;
  }
  ctx.ui.setEditorText(runtime.previousDraft);
  runtime.previousDraft = undefined;
  ctx.ui.notify("Restored previous draft.", "info");
}

function showStatus(ctx: ExtensionCommandContext, runtime: Runtime): void {
  const s = runtime.settings;
  const family = resolveFamily(s, ctx.model);
  const enhancer =
    s.enhancerModel.mode === "fixed"
      ? `${s.enhancerModel.ref.provider}/${s.enhancerModel.ref.id}`
      : ctx.model
        ? `active (${ctx.model.provider}/${ctx.model.id})`
        : "active (no model)";

  const lines = [
    `pi-prompt-enhancer — ${runtime.templates.length} template(s)`,
    `  templates dir : ${TEMPLATES_DIR}`,
    `  family mode   : ${s.familyMode} (resolved: ${family})`,
    `  fallback      : ${s.fallbackFamily}`,
    `  enhancer model: ${enhancer}`,
    `  default tpl   : ${s.defaultTechnique}`,
    `  notify        : ${s.notify ? "on" : "off"}`,
    `  preserve lang : ${s.preserveDraftLanguage ? "on" : "off"}`,
    `  command       : /${COMMAND}`,
    `  shortcut      : ${SHORTCUT}`,
  ];
  if (runtime.templateErrors.length > 0) {
    lines.push("", "Template errors:");
    for (const err of runtime.templateErrors) lines.push(`  - ${err}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function listTemplates(ctx: ExtensionCommandContext, runtime: Runtime): void {
  if (runtime.templates.length === 0) {
    ctx.ui.notify(`No templates in ${TEMPLATES_DIR}.`, "warning");
    return;
  }
  const lines = ["Templates:"];
  for (const tpl of runtime.templates) {
    const kws = tpl.keywords.length > 0 ? tpl.keywords.join(", ") : "(fallback)";
    lines.push(`  ${tpl.id.padEnd(12)} → ${kws}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function setFamilyMode(ctx: ExtensionCommandContext, runtime: Runtime, value: string): void {
  if (value !== "auto" && value !== "gpt" && value !== "claude") {
    ctx.ui.notify("Usage: /pe family auto|gpt|claude", "warning");
    return;
  }
  runtime.settings = { ...runtime.settings, familyMode: value };
  saveSettings(runtime.settings);
  ctx.ui.notify(`Family mode → ${value}.`, "info");
}

function setFallback(ctx: ExtensionCommandContext, runtime: Runtime, value: string): void {
  if (value !== "gpt" && value !== "claude") {
    ctx.ui.notify("Usage: /pe fallback gpt|claude", "warning");
    return;
  }
  runtime.settings = { ...runtime.settings, fallbackFamily: value as Family };
  saveSettings(runtime.settings);
  ctx.ui.notify(`Fallback family → ${value}.`, "info");
}

function setDefaultTemplate(ctx: ExtensionCommandContext, runtime: Runtime, value: string): void {
  if (!value) {
    ctx.ui.notify("Usage: /pe default <template-id>", "warning");
    return;
  }
  if (!findById(runtime.templates, value)) {
    ctx.ui.notify(`Template '${value}' not found. Run /pe list to see available ones.`, "warning");
    return;
  }
  runtime.settings = { ...runtime.settings, defaultTechnique: value };
  saveSettings(runtime.settings);
  ctx.ui.notify(`Default template → ${value}.`, "info");
}

function setEnhancerModel(ctx: ExtensionCommandContext, runtime: Runtime, args: string[]): void {
  const mode = args[0] ?? "";
  if (mode === "active") {
    runtime.settings = { ...runtime.settings, enhancerModel: { mode: "active" } };
    saveSettings(runtime.settings);
    ctx.ui.notify("Enhancer model → active session model.", "info");
    return;
  }
  if (mode === "fixed") {
    const ref = parseModelRef(args[1] ?? "");
    if (!ref) {
      ctx.ui.notify("Usage: /pe model fixed <provider>/<id>", "warning");
      return;
    }
    runtime.settings = { ...runtime.settings, enhancerModel: { mode: "fixed", ref } };
    saveSettings(runtime.settings);
    ctx.ui.notify(`Enhancer model → ${ref.provider}/${ref.id}.`, "info");
    return;
  }
  ctx.ui.notify("Usage: /pe model active | /pe model fixed <provider>/<id>", "warning");
}

function setNotify(ctx: ExtensionCommandContext, runtime: Runtime, value: string): void {
  const v = value.toLowerCase();
  if (v !== "on" && v !== "off") {
    ctx.ui.notify("Usage: /pe notify on|off", "warning");
    return;
  }
  runtime.settings = { ...runtime.settings, notify: v === "on" };
  saveSettings(runtime.settings);
  ctx.ui.notify(`Notifications → ${v}.`, "info");
}

function setPreserveLanguage(ctx: ExtensionCommandContext, runtime: Runtime, value: string): void {
  const v = value.toLowerCase();
  if (v !== "on" && v !== "off") {
    ctx.ui.notify("Usage: /pe language on|off", "warning");
    return;
  }
  runtime.settings = { ...runtime.settings, preserveDraftLanguage: v === "on" };
  saveSettings(runtime.settings);
  ctx.ui.notify(`Draft-language preservation → ${v}.`, "info");
}

function parseModelRef(spec: string): ModelRef | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash).trim(), id: spec.slice(slash + 1).trim() };
}
