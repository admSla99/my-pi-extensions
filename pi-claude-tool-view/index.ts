/**
 * Claude Code–style compact rendering for Pi's built-in tools.
 *
 * Collapsed (default):
 *   ● Bash(cd ~/Projects/agentix && gh pr edit 313 …)
 *     ⎿  6 lines of output (ctrl+o to expand)
 *
 * Expanded (`app.tools.expand`, ctrl+o by default, or click): Pi's original
 * renderers inside the usual colored box.
 *
 * Only rendering changes. Execution is delegated to a fresh built-in definition
 * per call so the session cwd and shell settings are honoured.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, TruncatedText } from "@earendil-works/pi-tui";

type AnyDef = ToolDefinition<any, any, any>;
type ToolRenderContext = Parameters<NonNullable<AnyDef["renderCall"]>>[2];
type Settings = ReturnType<ExtensionAPI["getSettings"]>;
type Result = { content: Array<{ type: string; text?: string }>; details?: any };

interface Compact {
	/** Claude Code–style tool label, e.g. "Bash". */
	label: string;
	/** Argument shown inside the parentheses. */
	arg: (args: any, cwd: string) => string;
	/** One-line summary of a successful result. */
	summary: (result: Result, args: any, cwd: string) => string;
}

const home = homedir();

function shortPath(p: string | undefined, cwd: string): string {
	if (!p) return "";
	const abs = isAbsolute(p) ? p : join(cwd, p);
	const rel = relative(cwd, abs);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
}

function text(result: Result): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function lines(s: string): string[] {
	return s.split("\n").filter((l) => l.trim());
}

function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`;
}

const COMPACT: Record<string, Compact> = {
	bash: {
		label: "Bash",
		arg: (a) => {
			const cmd: string = a.command ?? "";
			const first = cmd.split("\n")[0];
			return first === cmd ? cmd : `${first} …`;
		},
		summary: (r) => {
			const n = lines(text(r)).length;
			return n ? `${plural(n, "line")} of output` : "(No output)";
		},
	},
	read: {
		label: "Read",
		arg: (a, cwd) => {
			let s = shortPath(a.path, cwd);
			if (a.offset || a.limit) s += `:${a.offset ?? 1}${a.limit ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}`;
			return s;
		},
		summary: (r) => (r.content.some((c) => c.type === "image") ? "Read image" : `Read ${plural(text(r).replace(/\n$/, "").split("\n").length, "line")}`),
	},
	write: {
		label: "Write",
		arg: (a, cwd) => shortPath(a.path, cwd),
		summary: (_r, a, cwd) => `Wrote ${plural((a.content ?? "").split("\n").length, "line")} to ${shortPath(a.path, cwd)}`,
	},
	edit: {
		label: "Update",
		arg: (a, cwd) => shortPath(a.path, cwd),
		summary: (r) => {
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return diff ? `Updated with ${plural(add, "addition")} and ${plural(del, "removal")}` : "Updated";
		},
	},
	grep: {
		label: "Search",
		arg: (a, cwd) => `pattern: "${a.pattern ?? ""}"${a.path ? `, path: ${shortPath(a.path, cwd)}` : ""}${a.glob ? `, glob: ${a.glob}` : ""}`,
		summary: (r) => `Found ${plural(lines(text(r)).length, "line")}`,
	},
	find: {
		label: "Glob",
		arg: (a, cwd) => `${a.pattern ?? ""}${a.path ? ` in ${shortPath(a.path, cwd)}` : ""}`,
		summary: (r) => `Found ${plural(lines(text(r)).length, "file")}`,
	},
	ls: {
		label: "List",
		arg: (a, cwd) => shortPath(a.path ?? ".", cwd),
		summary: (r) => `Listed ${plural(lines(text(r)).length, "entry", "entries")}`,
	},
};

function bgFn(theme: Theme, ctx: ToolRenderContext) {
	const token = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
	return (s: string) => theme.bg(token, s);
}

export default function (pi: ExtensionAPI) {
	/** Wrapper component -> original renderer component, so originals can reuse their last component. */
	const inner = new WeakMap<Component, Component>();

	/**
	 * Always run the original renderer, even when collapsed: it keeps per-row state (bash timer,
	 * edit diff preview) that the expanded view needs later. Returns what to show.
	 */
	const show = (
		render: ((...a: any[]) => Component) | undefined,
		ctx: ToolRenderContext,
		args: any[],
		compact: () => Component,
		wrap: (orig: Component) => Component,
	): Component => {
		const orig = render?.(...args, { ...ctx, lastComponent: ctx.lastComponent && inner.get(ctx.lastComponent) });
		const out = ctx.expanded && orig ? wrap(orig) : compact();
		if (orig) inner.set(out, orig);
		return out;
	};

	const boxed = (theme: Theme, ctx: ToolRenderContext, ...children: Component[]) => {
		const box = new Box(1, 0, bgFn(theme, ctx));
		for (const child of children) box.addChild(child);
		return box;
	};

	// `settings` is undefined at load time: pi.getSettings() is only available once the session runs.
	const register = (name: keyof typeof COMPACT, make: (cwd: string, settings?: Settings) => AnyDef) => {
		const base = make(process.cwd());
		const c = COMPACT[name];

		pi.registerTool({
			...base,
			renderShell: "self",
			// Keep Pi's own activation rules: overriding must not enable grep/find/ls.
			defaultActive: false,
			execute: (id, params, signal, onUpdate, ctx) => make(ctx.cwd, pi.getSettings()).execute(id, params, signal, onUpdate, ctx),

			renderCall(args, theme, ctx) {
				return show(
					base.renderCall,
					ctx,
					[args, theme],
					() => {
						const dot = theme.fg(ctx.isPartial ? "muted" : ctx.isError ? "error" : "success", "●");
						const arg = c.arg(args ?? {}, ctx.cwd);
						return new TruncatedText(`${dot} ${theme.bold(c.label)}${arg ? `(${arg})` : ""}`, 0, 0);
					},
					(orig) => boxed(theme, ctx, new Spacer(1), orig),
				);
			},

			renderResult(result, options, theme, ctx) {
				return show(
					base.renderResult,
					ctx,
					[result, options, theme],
					() => {
						let summary: string;
						if (options.isPartial) {
							summary = theme.fg("muted", "Running…");
						} else if (ctx.isError) {
							const all = lines(text(result as Result));
							summary = theme.fg("error", all[all.length - 1] ?? "Error");
						} else {
							summary = theme.fg("muted", c.summary(result as Result, ctx.args ?? {}, ctx.cwd));
						}
						const hint = `${theme.fg("dim", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("dim", ")")}`;
						return new TruncatedText(`  ${theme.fg("dim", "⎿")}  ${summary} ${hint}`, 0, 0);
					},
					(orig) => boxed(theme, ctx, orig, new Spacer(1)),
				);
			},
		} as AnyDef);
	};

	const expandHome = (p?: string) => (p?.startsWith("~/") ? join(home, p.slice(2)) : p);

	register("bash", (cwd, s) =>
		createBashToolDefinition(cwd, { commandPrefix: s?.shellCommandPrefix, shellPath: expandHome(s?.shellPath) }),
	);
	register("read", (cwd, s) => createReadToolDefinition(cwd, { autoResizeImages: s?.images?.autoResize ?? true }));
	register("write", (cwd) => createWriteToolDefinition(cwd));
	register("edit", (cwd) => createEditToolDefinition(cwd));
	register("grep", (cwd) => createGrepToolDefinition(cwd));
	register("find", (cwd) => createFindToolDefinition(cwd));
	register("ls", (cwd) => createLsToolDefinition(cwd));
}
