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
 * update plugins itself — install them with Claude Code, then manage which are
 * active in pi with /plugins. Enable/disable and optional Pi scope overrides
 * live in a small pi-side state file.
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

export interface Install {
	scope: string; // "user" | "project" | "local"
	projectPath?: string; // set for project/local scope
	installPath: string;
}

export interface Plugin {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	installs: Install[];
}

type ResourceType = "skills" | "commands" | "agents";
const RESOURCE_TYPES: ResourceType[] = ["skills", "commands", "agents"];

export type ScopeOverride = "global" | string[];

export interface State {
	disabled: string[]; // whole plugins turned off
	// Per-plugin resource types turned off, e.g. { "agentix@mp": ["commands"] }.
	typesOff: Record<string, ResourceType[]>;
	// Pi-only scope overrides. Missing means use the Claude install scope.
	scopes: Record<string, ScopeOverride>;
}

// ── State (pi-side toggles and scopes; defaults come from Claude) ───────

export function loadState(statePath = STATE_PATH): State {
	try {
		const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		const scopes: Record<string, ScopeOverride> = {};
		if (raw?.scopes && typeof raw.scopes === "object") {
			for (const [id, value] of Object.entries(raw.scopes)) {
				if (value === "global") scopes[id] = value;
				else if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
					scopes[id] = value;
				}
			}
		}
		return {
			disabled: Array.isArray(raw?.disabled) ? raw.disabled : [],
			typesOff:
				raw?.typesOff && typeof raw.typesOff === "object" ? raw.typesOff : {},
			scopes,
		};
	} catch {
		return { disabled: [], typesOff: {}, scopes: {} };
	}
}

export function saveState(state: State, statePath = STATE_PATH): void {
	// Drop empty type arrays to keep the file tidy.
	const typesOff: Record<string, ResourceType[]> = {};
	for (const [id, types] of Object.entries(state.typesOff)) {
		if (types.length) typesOff[id] = types;
	}
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	const tempPath = `${statePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(
			tempPath,
			`${JSON.stringify({ disabled: state.disabled, typesOff, scopes: state.scopes }, null, 2)}\n`,
		);
		fs.renameSync(tempPath, statePath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {}
	}
}

/** A resource type is active for a plugin unless its plugin or type is off. */
function typeActive(state: State, id: string, type: ResourceType): boolean {
	if (state.disabled.includes(id)) return false;
	return !(state.typesOff[id]?.includes(type) ?? false);
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
export function activeInstall(
	plugin: Plugin,
	cwd: string,
	state: State = loadState(),
): Install | undefined {
	if (Object.hasOwn(state.scopes, plugin.id)) {
		const override = state.scopes[plugin.id];
		if (override === "global") return plugin.installs[0];
		const projectPath = override.find((p) => within(cwd, p));
		return projectPath
			? { ...plugin.installs[0], scope: "local", projectPath }
			: undefined;
	}
	const user = plugin.installs.find((i) => i.scope === "user");
	if (user) return user;
	return plugin.installs.find((i) => i.projectPath && within(cwd, i.projectPath));
}

function shortPath(p: string): string {
	const home = os.homedir();
	return p === home || p.startsWith(`${home}${path.sep}`)
		? `~${p.slice(home.length)}`
		: p;
}

/** Human-readable scope label for the UI. */
export function scopeLabel(plugin: Plugin, state: State = loadState()): string {
	if (Object.hasOwn(state.scopes, plugin.id)) {
		const override = state.scopes[plugin.id];
		if (override === "global") return "pi:global";
		return override.length ? `pi:${override.map(shortPath).join(",")}` : "pi:none";
	}
	if (plugin.installs.some((i) => i.scope === "user")) return "global";
	const scoped = plugin.installs.filter((i) => i.projectPath);
	return scoped.length
		? scoped.map((i) => `${i.scope}:${shortPath(i.projectPath!)}`).join(",")
		: "?";
}

function enabledPlugins(state: State = loadState()): Plugin[] {
	const disabled = new Set(state.disabled);
	return discoverPlugins().filter((p) => !disabled.has(p.id));
}

/** Enabled plugins whose scope applies to `cwd`, paired with the active install. */
function activePlugins(
	cwd: string,
	state: State = loadState(),
): Array<{ plugin: Plugin; install: Install }> {
	const result: Array<{ plugin: Plugin; install: Install }> = [];
	for (const plugin of enabledPlugins(state)) {
		const install = activeInstall(plugin, cwd, state);
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
	const state = loadState();
	const names: string[] = [];
	for (const { plugin, install } of activePlugins(cwd, state)) {
		if (!typeActive(state, plugin.id, "agents")) continue;
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

/** Install to display in the UI: the one active here, else the first known. */
function displayInstall(plugin: Plugin, cwd: string, state: State): Install {
	return activeInstall(plugin, cwd, state) ?? plugin.installs[0];
}

/** Which resource types a plugin actually ships (from its display install). */
function pluginHas(
	plugin: Plugin,
	cwd: string,
	state: State,
): Record<ResourceType, boolean> {
	const ip = displayInstall(plugin, cwd, state).installPath;
	return {
		skills: !!dirIfExists(path.join(ip, "skills")),
		commands: !!dirIfExists(path.join(ip, "commands")),
		agents: listMd(path.join(ip, "agents")).length > 0,
	};
}

export function resolveProjectPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Project path is required.");
	const expanded = trimmed === "~"
		? HOME
		: trimmed.startsWith(`~${path.sep}`)
			? path.join(HOME, trimmed.slice(2))
			: trimmed;
	const resolved = fs.realpathSync(path.resolve(cwd, expanded));
	if (!fs.statSync(resolved).isDirectory()) throw new Error("Project path is not a directory.");
	return resolved;
}

function projectScopes(plugin: Plugin, state: State): string[] | undefined {
	if (Object.hasOwn(state.scopes, plugin.id)) {
		const override = state.scopes[plugin.id];
		return override === "global" ? undefined : override;
	}
	return plugin.installs.flatMap((i) => i.projectPath ? [i.projectPath] : []);
}

async function editPluginScope(
	ctx: ExtensionCommandContext,
	plugin: Plugin,
	state: State,
): Promise<void> {
	const action = await ctx.ui.select(
		`Pi scope for ${plugin.id} (${scopeLabel(plugin, state)}):`,
		[
			"Global (all projects)",
			"Current project only",
			"Choose project only…",
			"Add project…",
			"Remove project…",
			"No scope (load nowhere)",
			"Use Claude scope",
		],
	);
	if (!action) return;

	if (action === "Global (all projects)") {
		state.scopes[plugin.id] = "global";
		return;
	}
	if (action === "Current project only") {
		state.scopes[plugin.id] = [fs.realpathSync(ctx.cwd)];
		return;
	}
	if (action === "No scope (load nowhere)") {
		state.scopes[plugin.id] = [];
		return;
	}
	if (action === "Use Claude scope") {
		delete state.scopes[plugin.id];
		return;
	}
	if (action === "Remove project…") {
		const projects = projectScopes(plugin, state);
		if (!projects?.length) {
			ctx.ui.notify("This plugin has no project scopes to remove.", "warning");
			return;
		}
		const selected = await ctx.ui.select("Remove project scope:", projects);
		if (selected) state.scopes[plugin.id] = projects.filter((p) => p !== selected);
		return;
	}

	const input = await ctx.ui.input("Project path:", ctx.cwd);
	if (input === undefined) return;
	try {
		const projectPath = resolveProjectPath(input, ctx.cwd);
		state.scopes[plugin.id] = action === "Choose project only…"
			? [projectPath]
			: Array.from(new Set([...(projectScopes(plugin, state) ?? []), projectPath]));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

const TYPE_LETTER: Record<ResourceType, string> = { skills: "S", commands: "C", agents: "A" };

async function showToggleUi(ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const plugins = discoverPlugins();

	if (plugins.length === 0) {
		ctx.ui.notify(
			"No Claude plugins found (~/.claude/plugins/installed_plugins.json). Install some with Claude Code first.",
			ctx.hasUI ? "warning" : "info",
		);
		return;
	}

	// Working copy of state, mutated in the UI, persisted only on apply.
	const saved = loadState();
	const disabled = new Set(saved.disabled);
	const typesOff = new Map<string, Set<ResourceType>>();
	for (const [id, types] of Object.entries(saved.typesOff)) {
		typesOff.set(id, new Set(types));
	}
	const scopes = Object.fromEntries(
		Object.entries(saved.scopes).map(([id, value]) => [
			id,
			Array.isArray(value) ? [...value] : value,
		]),
	) as Record<string, ScopeOverride>;
	const currentState = (): State => ({
		disabled: Array.from(disabled),
		typesOff: Object.fromEntries(
			Array.from(typesOff, ([id, types]) => [id, Array.from(types)]),
		),
		scopes,
	});
	const typeOn = (id: string, t: ResourceType) =>
		!disabled.has(id) && !typesOff.get(id)?.has(t);

	if (ctx.mode !== "tui") {
		const state = currentState();
		const lines = plugins.map((p) => {
			const active = !!activeInstall(p, cwd, state);
			const box = disabled.has(p.id) ? "[ ]" : active ? "[x]" : "[-]";
			const has = pluginHas(p, cwd, state);
			const types = RESOURCE_TYPES.filter((t) => has[t])
				.map((t) => `${t}${typeOn(p.id, t) ? "✓" : "✗"}`)
				.join(" ");
			return `${box} ${p.id}  (${scopeLabel(p, state)}; ${types || "no resources"})`;
		});
		ctx.ui.notify(
			`Claude plugins ([x] active here, [-] out of scope, [ ] disabled):\n${lines.join("\n")}`,
			"info",
		);
		return;
	}

	type UiResult = "apply" | "cancel" | { scopeId: string };
	let cursor = 0;
	let result: UiResult;
	do {
		result = await ctx.ui.custom<UiResult>((tui, theme, _kb, done) => {
			const refresh = () => tui.requestRender();

			function typeBadges(p: Plugin): string {
				const state = currentState();
				const has = pluginHas(p, cwd, state);
				return RESOURCE_TYPES.map((t) => {
					const letter = TYPE_LETTER[t];
					if (!has[t]) return theme.fg("dim", "·");
					return typeOn(p.id, t)
						? theme.fg("success", letter)
						: theme.fg("error", letter.toLowerCase());
				}).join(" ");
			}

			// Build fresh each render so it always reflects the working state.
			function build(): Container {
				const state = currentState();
				const container = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const rows: string[] = [];
				rows.push(theme.fg("accent", theme.bold("Claude plugins in pi")));
				rows.push(theme.fg("dim", `cwd: ${cwd}`));
				rows.push(theme.fg("dim", "space: on/off   s/c/a: resources   p: scope"));
				rows.push(theme.fg("dim", "↑/↓: move   enter: apply+reload   esc: cancel"));
				rows.push("");
				plugins.forEach((p, i) => {
					const enabled = !disabled.has(p.id);
					const active = !!activeInstall(p, cwd, state);
					const box = !enabled
						? theme.fg("dim", "[ ]")
						: active
							? theme.fg("success", "[x]")
							: theme.fg("muted", "[-]");
					const pointer = i === cursor ? theme.fg("accent", "›") : " ";
					const label = i === cursor ? theme.bold(p.id) : p.id;
					const scope = theme.fg(active ? "text" : "muted", scopeLabel(p, state));
					rows.push(`${pointer} ${box} ${typeBadges(p)}  ${label}  ${scope}`);
				});
				container.addChild(border);
				for (const row of rows) container.addChild(new Text(row, 1, 0));
				container.addChild(border);
				return container;
			}

			function toggleType(p: Plugin, type: ResourceType) {
				if (!pluginHas(p, cwd, currentState())[type]) return;
				let set = typesOff.get(p.id);
				if (!set) {
					set = new Set();
					typesOff.set(p.id, set);
				}
				if (set.has(type)) set.delete(type);
				else set.add(type);
			}

			return {
				render: (width: number): string[] => build().render(width),
				invalidate: () => {},
				handleInput: (data: string) => {
					const plugin = plugins[cursor];
					if (matchesKey(data, Key.up) || data === "k") {
						cursor = (cursor - 1 + plugins.length) % plugins.length;
						refresh();
					} else if (matchesKey(data, Key.down) || data === "j") {
						cursor = (cursor + 1) % plugins.length;
						refresh();
					} else if (data === " ") {
						if (disabled.has(plugin.id)) disabled.delete(plugin.id);
						else disabled.add(plugin.id);
						refresh();
					} else if (data === "s") {
						toggleType(plugin, "skills");
						refresh();
					} else if (data === "c") {
						toggleType(plugin, "commands");
						refresh();
					} else if (data === "a") {
						toggleType(plugin, "agents");
						refresh();
					} else if (data === "p") {
						done({ scopeId: plugin.id });
					} else if (matchesKey(data, Key.enter)) {
						done("apply");
					} else if (matchesKey(data, Key.escape)) {
						done("cancel");
					}
				},
			};
		});
		if (typeof result === "object") {
			const scopeId = result.scopeId;
			const plugin = plugins.find((p) => p.id === scopeId);
			if (plugin) await editPluginScope(ctx, plugin, currentState());
		}
	} while (typeof result === "object");

	if (result !== "apply") {
		ctx.ui.notify("Plugins unchanged.", "info");
		return;
	}

	saveState(currentState());
	ctx.ui.notify("Saved. Reloading resources…", "info");
	await ctx.reload();
}

// ── Extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Skills + commands: contributed dynamically, scoped to the current cwd.
	// Pi scope overrides win; otherwise Claude's user/project/local scope applies.
	// Claude's registry and settings are never edited.
	pi.on("resources_discover", (event) => {
		const state = loadState();
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const { plugin, install } of activePlugins(event.cwd, state)) {
			const skills = dirIfExists(path.join(install.installPath, "skills"));
			const commands = dirIfExists(path.join(install.installPath, "commands"));
			if (skills && typeActive(state, plugin.id, "skills")) skillPaths.push(skills);
			if (commands && typeActive(state, plugin.id, "commands")) promptPaths.push(commands);
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
		description: "Manage Claude Code plugin resources and Pi scopes",
		handler: async (_args, ctx) => {
			await showToggleUi(ctx);
		},
	});
}
