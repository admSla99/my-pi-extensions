/**
 * pi-claude-plugins
 *
 * Discover and manage Claude Code plugins from inside pi, without hand-editing
 * settings.json. Ports three resource types:
 *   - skills/   -> pi skills   (via resources_discover skillPaths)
 *   - commands/ -> pi prompts  (via resources_discover promptPaths)
 *   - agents/   -> pi subagents (via the pi-subagents globalThis hook)
 *
 * Source of truth for what is installed is Claude Code's own registry at
 * ~/.claude/plugins/installed_plugins.json. This extension does NOT install or
 * update plugins itself — install them with Claude Code, then toggle which ones
 * are active in pi with /plugins. Enable/disable state lives in a small pi-side
 * file; everything else is derived from disk on each (re)load.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DynamicBorder,
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";

// ── Paths ──────────────────────────────────────────────────────────────

const HOME = os.homedir();
const CLAUDE_PLUGINS_DIR = path.join(HOME, ".claude", "plugins");
const INSTALLED_JSON = path.join(CLAUDE_PLUGINS_DIR, "installed_plugins.json");
const STATE_PATH = path.join(HOME, ".pi", "agent", "claude-plugins-state.json");

// Default subagent model. Claude agent `model:` values (haiku/opus/inherit/…)
// don't map cleanly to pi model ids, so we ignore them and use one enabled
// model. ponytail: single default; edit the agent .md or this const to change.
const DEFAULT_AGENT_MODEL = "anthropic/claude-sonnet-4-6";

// Claude tool names -> pi tool names. Anything not here is dropped.
const TOOL_MAP: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	webfetch: "web_fetch",
	web_fetch: "web_fetch",
	websearch: "web_search",
	web_search: "web_search",
};
const DEFAULT_AGENT_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

// ── Types ──────────────────────────────────────────────────────────────

interface Plugin {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	installPath: string;
	skillsDir?: string;
	commandsDir?: string;
	agentFiles: string[];
}

interface State {
	disabled: string[];
}

// ── State (pi-side enable/disable; default enabled) ────────────────────

function loadState(): State {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
		if (Array.isArray(raw?.disabled)) return { disabled: raw.disabled };
	} catch {}
	return { disabled: [] };
}

function saveState(state: State): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Discovery (Claude registry -> Plugin[]) ────────────────────────────

function dirIfExists(p: string): string | undefined {
	try {
		return fs.statSync(p).isDirectory() ? p : undefined;
	} catch {
		return undefined;
	}
}

function listMd(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

/** Read Claude's installed_plugins.json and resolve each plugin's install dir. */
function discoverPlugins(): Plugin[] {
	let data: any;
	try {
		data = JSON.parse(fs.readFileSync(INSTALLED_JSON, "utf-8"));
	} catch {
		return [];
	}
	const plugins: Plugin[] = [];
	const entries: Record<string, any[]> = data?.plugins ?? {};
	for (const [id, installs] of Object.entries(entries)) {
		if (!Array.isArray(installs)) continue;
		// Pick the first install whose path exists on disk.
		const install = installs.find((i) => i?.installPath && dirIfExists(i.installPath));
		if (!install) continue;
		const installPath: string = install.installPath;
		const [name, marketplace = "?"] = id.split("@");
		plugins.push({
			id,
			name,
			marketplace,
			installPath,
			skillsDir: dirIfExists(path.join(installPath, "skills")),
			commandsDir: dirIfExists(path.join(installPath, "commands")),
			agentFiles: listMd(path.join(installPath, "agents")),
		});
	}
	plugins.sort((a, b) => a.id.localeCompare(b.id));
	return plugins;
}

function enabledPlugins(): Plugin[] {
	const disabled = new Set(loadState().disabled);
	return discoverPlugins().filter((p) => !disabled.has(p.id));
}

// ── Agents -> pi-subagents ─────────────────────────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	thinking: string;
	systemPrompt: string;
	filePath: string;
	subagentAgents?: string[];
}

type SubagentHook = {
	registerAgent: (c: AgentConfig) => void;
	unregisterAgent: (name: string) => void;
};

function subagentHook(): SubagentHook | undefined {
	return (globalThis as any).__pi_subagents;
}

function mapTools(raw: string | undefined): string[] {
	if (!raw?.trim()) return [...DEFAULT_AGENT_TOOLS];
	const mapped = raw
		.split(",")
		.map((t) => TOOL_MAP[t.trim().toLowerCase()])
		.filter((t): t is string => Boolean(t));
	return mapped.length ? Array.from(new Set(mapped)) : [...DEFAULT_AGENT_TOOLS];
}

// Names we registered, so we can cleanly re-register on reload.
let registeredAgents: string[] = [];

function unregisterOurAgents(): void {
	const hook = subagentHook();
	if (hook) for (const name of registeredAgents) hook.unregisterAgent(name);
	registeredAgents = [];
}

function registerAgents(): string[] {
	unregisterOurAgents();
	const hook = subagentHook();
	if (!hook) return []; // pi-subagents not installed; skills/commands still work.
	const names: string[] = [];
	for (const plugin of enabledPlugins()) {
		for (const file of plugin.agentFiles) {
			try {
				const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
					fs.readFileSync(file, "utf-8"),
				);
				if (!frontmatter.name) continue;
				hook.registerAgent({
					name: frontmatter.name,
					description: frontmatter.description || "",
					tools: mapTools(frontmatter.tools),
					model: DEFAULT_AGENT_MODEL,
					thinking: frontmatter.thinking || "medium",
					systemPrompt: body,
					filePath: file,
				});
				registeredAgents.push(frontmatter.name);
				names.push(frontmatter.name);
			} catch {
				// Duplicate name or unreadable file — skip, keep going.
			}
		}
	}
	return names;
}

// ── Interactive /plugins toggle UI ─────────────────────────────────────

function resourceTag(p: Plugin): string {
	const parts: string[] = [];
	if (p.skillsDir) parts.push("skills");
	if (p.commandsDir) parts.push(`cmds`);
	if (p.agentFiles.length) parts.push(`agents:${p.agentFiles.length}`);
	return parts.length ? parts.join(" ") : "no resources";
}

async function showToggleUi(ctx: ExtensionCommandContext): Promise<void> {
	const plugins = discoverPlugins();

	if (!ctx.hasUI) {
		const disabled = new Set(loadState().disabled);
		const lines = plugins.map(
			(p) => `${disabled.has(p.id) ? "[ ]" : "[x]"} ${p.id}  (${resourceTag(p)})`,
		);
		ctx.ui.notify(
			plugins.length
				? `Claude plugins:\n${lines.join("\n")}`
				: "No Claude plugins found (~/.claude/plugins/installed_plugins.json).",
			"info",
		);
		return;
	}

	if (plugins.length === 0) {
		ctx.ui.notify("No Claude plugins found. Install some with Claude Code first.", "warning");
		return;
	}

	const disabled = new Set(loadState().disabled);
	const changed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		let cursor = 0;

		function refresh() {
			tui.requestRender();
		}

		// Build a fresh container each render so it always reflects live state.
		function build(): Container {
			const container = new Container();
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const rows: string[] = [];
			rows.push(theme.fg("accent", theme.bold("Claude plugins in pi")));
			rows.push(theme.fg("dim", "space: toggle   ↑/↓: move   enter: apply+reload   esc: cancel"));
			rows.push("");
			plugins.forEach((p, i) => {
				const on = !disabled.has(p.id);
				const box = on ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const pointer = i === cursor ? theme.fg("accent", "›") : " ";
				const label = i === cursor ? theme.bold(p.id) : p.id;
				const tag = theme.fg("dim", `  ${resourceTag(p)}`);
				rows.push(`${pointer} ${box} ${label}${tag}`);
			});
			container.addChild(border);
			for (const r of rows) container.addChild(new Text(r, 1, 0));
			container.addChild(border);
			return container;
		}

		return {
			render: (width: number): string[] => build().render(width),
			invalidate: () => {},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up) || data === "k") {
					cursor = (cursor - 1 + plugins.length) % plugins.length;
					refresh();
				} else if (matchesKey(data, Key.down) || data === "j") {
					cursor = (cursor + 1) % plugins.length;
					refresh();
				} else if (data === " ") {
					const id = plugins[cursor].id;
					if (disabled.has(id)) disabled.delete(id);
					else disabled.add(id);
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					done(true);
				} else if (matchesKey(data, Key.escape)) {
					done(false);
				}
			},
		};
	});

	if (!changed) {
		ctx.ui.notify("Plugins unchanged.", "info");
		return;
	}

	saveState({ disabled: Array.from(disabled) });
	ctx.ui.notify("Saved. Reloading resources…", "info");
	await ctx.reload();
}

// ── Extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Skills + commands: contributed dynamically, no settings.json edits.
	pi.on("resources_discover", () => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const p of enabledPlugins()) {
			if (p.skillsDir) skillPaths.push(p.skillsDir);
			if (p.commandsDir) promptPaths.push(p.commandsDir);
		}
		return { skillPaths, promptPaths };
	});

	// Agents: registered against pi-subagents after all extensions have loaded.
	pi.on("session_start", () => {
		registerAgents();
	});

	pi.on("session_shutdown", () => {
		unregisterOurAgents();
	});

	pi.registerCommand("plugins", {
		description: "Manage Claude Code plugins (skills, commands, agents) in pi",
		handler: async (_args, ctx) => {
			await showToggleUi(ctx);
		},
	});
}
