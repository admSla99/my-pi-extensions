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

interface Install {
	scope: string; // "user" | "project" | "local"
	projectPath?: string; // set for project/local scope
	installPath: string;
}

interface Plugin {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	installs: Install[];
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

/** Read Claude's installed_plugins.json and resolve each plugin's installs. */
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
		// Keep every install whose path exists on disk, with its scope.
		const resolved: Install[] = installs
			.filter((i) => i?.installPath && dirIfExists(i.installPath))
			.map((i) => ({
				scope: String(i.scope ?? "user"),
				projectPath: i.projectPath,
				installPath: i.installPath as string,
			}));
		if (resolved.length === 0) continue;
		const [name, marketplace = "?"] = id.split("@");
		plugins.push({ id, name, marketplace, installs: resolved });
	}
	plugins.sort((a, b) => a.id.localeCompare(b.id));
	return plugins;
}

/** True when `cwd` is inside (or equal to) `dir`. */
function within(cwd: string, dir: string): boolean {
	const rel = path.relative(dir, cwd);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The install that applies to `cwd`, or undefined if the plugin is out of scope
 * here. `user` scope is global; `project`/`local` only apply under projectPath.
 */
function activeInstall(plugin: Plugin, cwd: string): Install | undefined {
	const user = plugin.installs.find((i) => i.scope === "user");
	if (user) return user;
	return plugin.installs.find((i) => i.projectPath && within(cwd, i.projectPath));
}

/** Human-readable scope label for the UI. */
function scopeLabel(plugin: Plugin): string {
	if (plugin.installs.some((i) => i.scope === "user")) return "global";
	const scoped = plugin.installs.find((i) => i.projectPath);
	if (!scoped) return "?";
	const home = os.homedir();
	const p = scoped.projectPath!.startsWith(home)
		? `~${scoped.projectPath!.slice(home.length)}`
		: scoped.projectPath!;
	return `${scoped.scope}:${p}`;
}

function enabledPlugins(): Plugin[] {
	const disabled = new Set(loadState().disabled);
	return discoverPlugins().filter((p) => !disabled.has(p.id));
}

/** Enabled plugins whose scope applies to `cwd`, paired with the active install. */
function activePlugins(cwd: string): Array<{ plugin: Plugin; install: Install }> {
	const result: Array<{ plugin: Plugin; install: Install }> = [];
	for (const plugin of enabledPlugins()) {
		const install = activeInstall(plugin, cwd);
		if (install) result.push({ plugin, install });
	}
	return result;
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

function registerAgents(cwd: string): string[] {
	unregisterOurAgents();
	const hook = subagentHook();
	if (!hook) return []; // pi-subagents not installed; skills/commands still work.
	const names: string[] = [];
	for (const { install } of activePlugins(cwd)) {
		for (const file of listMd(path.join(install.installPath, "agents"))) {
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

function resourceTag(installPath: string): string {
	const parts: string[] = [];
	if (dirIfExists(path.join(installPath, "skills"))) parts.push("skills");
	if (dirIfExists(path.join(installPath, "commands"))) parts.push("cmds");
	const agents = listMd(path.join(installPath, "agents")).length;
	if (agents) parts.push(`agents:${agents}`);
	return parts.length ? parts.join(" ") : "no resources";
}

/** Install to display in the UI: the one active here, else the first known. */
function displayInstall(plugin: Plugin, cwd: string): Install {
	return activeInstall(plugin, cwd) ?? plugin.installs[0];
}

async function showToggleUi(ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const plugins = discoverPlugins();

	if (!ctx.hasUI) {
		const disabled = new Set(loadState().disabled);
		const lines = plugins.map((p) => {
			const active = !!activeInstall(p, cwd);
			const state = disabled.has(p.id) ? "[ ]" : active ? "[x]" : "[-]";
			const inst = displayInstall(p, cwd);
			return `${state} ${p.id}  (${scopeLabel(p)}; ${resourceTag(inst.installPath)})`;
		});
		ctx.ui.notify(
			plugins.length
				? `Claude plugins ([x] active here, [-] out of scope, [ ] disabled):\n${lines.join("\n")}`
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
			rows.push(theme.fg("dim", `cwd: ${cwd}`));
			rows.push(theme.fg("dim", "space: toggle   ↑/↓: move   enter: apply+reload   esc: cancel"));
			rows.push("");
			plugins.forEach((p, i) => {
				const enabled = !disabled.has(p.id);
				const active = !!activeInstall(p, cwd);
				const box = !enabled
					? theme.fg("dim", "[ ]")
					: active
						? theme.fg("success", "[x]")
						: theme.fg("muted", "[-]");
				const pointer = i === cursor ? theme.fg("accent", "›") : " ";
				const label = i === cursor ? theme.bold(p.id) : p.id;
				const scope = theme.fg(active ? "text" : "muted", scopeLabel(p));
				const tag = theme.fg("dim", resourceTag(displayInstall(p, cwd).installPath));
				rows.push(`${pointer} ${box} ${label}  ${scope}  ${tag}`);
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
	// Skills + commands: contributed dynamically, scoped to the current cwd.
	// user-scoped plugins are global; project/local plugins only load when the
	// cwd is inside their projectPath. No settings.json edits.
	pi.on("resources_discover", (event) => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const { install } of activePlugins(event.cwd)) {
			const skills = dirIfExists(path.join(install.installPath, "skills"));
			const commands = dirIfExists(path.join(install.installPath, "commands"));
			if (skills) skillPaths.push(skills);
			if (commands) promptPaths.push(commands);
		}
		return { skillPaths, promptPaths };
	});

	// Agents: registered against pi-subagents after all extensions have loaded,
	// scoped to the current cwd.
	pi.on("session_start", (_event, ctx) => {
		registerAgents(ctx.cwd);
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
