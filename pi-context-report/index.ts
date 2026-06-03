/**
 * pi-context-report
 *
 * Registers a `/context` command that reports context-window usage for the
 * current session, broken down by:
 *
 *   - system prompt
 *   - user messages
 *   - tool calls + results (including bash executions)
 *   - cache (read + write from the last assistant turn)
 *
 * Plus an "other" line for assistant text/thinking and summaries so the
 * percentages add up honestly. Percentages are relative to the current
 * model's context window.
 *
 * Token counts for content categories are estimated with the same chars/4
 * heuristic pi uses internally (see `estimateTokens` in the compaction
 * module). Cache numbers come straight from the most recent assistant
 * message's reported usage.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Token estimation (chars/4, matches pi's internal heuristic)
// ---------------------------------------------------------------------------

const IMAGE_CHARS = 4800;

function tokensFromChars(chars: number): number {
	return Math.ceil(chars / 4);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") total += b.text.length;
		else if (b.type === "image") total += IMAGE_CHARS;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Categorisation
// ---------------------------------------------------------------------------

interface Buckets {
	systemChars: number;
	userChars: number;
	toolChars: number;
	otherChars: number;
}

interface CategoryBreakdown {
	systemTokens: number;
	userTokens: number;
	toolTokens: number;
	otherTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	contextWindow: number;
	reportedContextTokens: number | null;
	modelLabel: string;
	hasUsage: boolean;
}

function categorise(entries: SessionEntry[], systemPrompt: string): Buckets {
	const buckets: Buckets = {
		systemChars: systemPrompt.length,
		userChars: 0,
		toolChars: 0,
		otherChars: 0,
	};

	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (!msg || typeof msg !== "object") break;
				const role = (msg as { role?: string }).role;
				switch (role) {
					case "user": {
						buckets.userChars += contentChars((msg as { content: unknown }).content);
						break;
					}
					case "assistant": {
						const content = (msg as { content?: unknown[] }).content;
						if (!Array.isArray(content)) break;
						for (const block of content) {
							if (!block || typeof block !== "object") continue;
							const b = block as {
								type?: string;
								text?: string;
								thinking?: string;
								name?: string;
								arguments?: unknown;
							};
							if (b.type === "text" && typeof b.text === "string") {
								buckets.otherChars += b.text.length;
							} else if (b.type === "thinking" && typeof b.thinking === "string") {
								buckets.otherChars += b.thinking.length;
							} else if (b.type === "toolCall") {
								const name = typeof b.name === "string" ? b.name : "";
								let argChars = 0;
								try {
									argChars = JSON.stringify(b.arguments ?? {}).length;
								} catch {
									argChars = 0;
								}
								buckets.toolChars += name.length + argChars;
							}
						}
						break;
					}
					case "toolResult": {
						buckets.toolChars += contentChars((msg as { content: unknown }).content);
						break;
					}
					case "bashExecution": {
						const m = msg as { command?: string; output?: string };
						buckets.toolChars += (m.command?.length ?? 0) + (m.output?.length ?? 0);
						break;
					}
					case "custom": {
						buckets.otherChars += contentChars((msg as { content: unknown }).content);
						break;
					}
					case "branchSummary":
					case "compactionSummary": {
						const summary = (msg as { summary?: string }).summary ?? "";
						buckets.otherChars += summary.length;
						break;
					}
				}
				break;
			}
			case "custom_message": {
				buckets.otherChars += contentChars((entry as { content: unknown }).content);
				break;
			}
			case "branch_summary":
			case "compaction": {
				const summary = (entry as { summary?: string }).summary ?? "";
				buckets.otherChars += summary.length;
				break;
			}
			default:
				break;
		}
	}

	return buckets;
}

// ---------------------------------------------------------------------------
// Walk the session entries backwards to find the latest assistant Usage.
// ---------------------------------------------------------------------------

interface UsageSnapshot {
	cacheRead: number;
	cacheWrite: number;
}

function findLastAssistantUsage(entries: SessionEntry[]): UsageSnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as {
			role?: string;
			stopReason?: string;
			usage?: { cacheRead?: number; cacheWrite?: number };
		};
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
		const u = msg.usage;
		if (!u) continue;
		return {
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

function buildBreakdown(ctx: ExtensionCommandContext): CategoryBreakdown {
	const branch = ctx.sessionManager.getBranch();
	const systemPrompt = ctx.getSystemPrompt();
	const buckets = categorise(branch, systemPrompt);
	const usage = findLastAssistantUsage(branch);
	const contextUsage = ctx.getContextUsage();
	const model = ctx.model;

	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const reportedContextTokens = contextUsage?.tokens ?? null;

	const modelLabel = model ? `${model.provider}/${model.id}` : "(no model)";

	return {
		systemTokens: tokensFromChars(buckets.systemChars),
		userTokens: tokensFromChars(buckets.userChars),
		toolTokens: tokensFromChars(buckets.toolChars),
		otherTokens: tokensFromChars(buckets.otherChars),
		cacheReadTokens: usage?.cacheRead ?? 0,
		cacheWriteTokens: usage?.cacheWrite ?? 0,
		contextWindow,
		reportedContextTokens,
		modelLabel,
		hasUsage: usage !== undefined,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const NUMBER_FMT = new Intl.NumberFormat("en-US");

function fmtTokens(n: number): string {
	return NUMBER_FMT.format(Math.max(0, Math.round(n)));
}

function fmtPercent(n: number, total: number): string {
	if (!total || total <= 0) return "  n/a";
	const pct = (n / total) * 100;
	if (pct >= 100) return `${pct.toFixed(1)}%`;
	if (pct >= 10) return ` ${pct.toFixed(1)}%`;
	return `  ${pct.toFixed(1)}%`;
}

function padLeft(s: string, width: number): string {
	if (s.length >= width) return s;
	return " ".repeat(width - s.length) + s;
}

function padRight(s: string, width: number): string {
	if (s.length >= width) return s;
	return s + " ".repeat(width - s.length);
}

interface Row {
	label: string;
	tokens: number;
	pctBase: number; // denominator for the % column
	highlight?: boolean;
}

function renderRow(row: Row, labelWidth: number, tokenWidth: number): string {
	const tok = padLeft(fmtTokens(row.tokens), tokenWidth);
	const pct = fmtPercent(row.tokens, row.pctBase);
	return `  ${padRight(row.label, labelWidth)}  ${tok}   ${pct}`;
}

function buildReportLines(b: CategoryBreakdown): string[] {
	const contentSum = b.systemTokens + b.userTokens + b.toolTokens + b.otherTokens;
	const window = b.contextWindow;

	const rows: Row[] = [
		{ label: "System prompt", tokens: b.systemTokens, pctBase: window },
		{ label: "User messages", tokens: b.userTokens, pctBase: window },
		{ label: "Tool calls + results", tokens: b.toolTokens, pctBase: window },
		{ label: "Other (assistant/summaries)", tokens: b.otherTokens, pctBase: window },
	];

	const labelWidth = Math.max(...rows.map((r) => r.label.length), "Sum (estimated)".length);
	const tokenWidth = Math.max(
		fmtTokens(contentSum).length,
		fmtTokens(b.cacheReadTokens).length,
		fmtTokens(b.cacheWriteTokens).length,
		fmtTokens(window).length,
	);

	const lines: string[] = [];
	lines.push("Estimated tokens by category (chars/4):");
	lines.push("");
	for (const row of rows) {
		lines.push(renderRow(row, labelWidth, tokenWidth));
	}
	const sep = "  " + "─".repeat(labelWidth + tokenWidth + 9);
	lines.push(sep);
	lines.push(
		renderRow(
			{ label: "Sum (estimated)", tokens: contentSum, pctBase: window },
			labelWidth,
			tokenWidth,
		),
	);
	lines.push("");
	lines.push("Cache (from last assistant turn):");
	lines.push("");
	if (b.hasUsage) {
		lines.push(
			renderRow(
				{ label: "Cache read", tokens: b.cacheReadTokens, pctBase: window },
				labelWidth,
				tokenWidth,
			),
		);
		lines.push(
			renderRow(
				{ label: "Cache write", tokens: b.cacheWriteTokens, pctBase: window },
				labelWidth,
				tokenWidth,
			),
		);
	} else {
		lines.push("  (no assistant turn with usage data yet)");
	}
	lines.push("");
	lines.push(`  Model:           ${b.modelLabel}`);
	lines.push(
		`  Context window:  ${window > 0 ? `${fmtTokens(window)} tokens` : "(unknown)"}`,
	);
	if (b.reportedContextTokens !== null) {
		const pct = window > 0 ? fmtPercent(b.reportedContextTokens, window).trim() : "n/a";
		lines.push(
			`  Reported usage:  ${fmtTokens(b.reportedContextTokens)} tokens  (${pct} of window)`,
		);
	} else {
		lines.push("  Reported usage:  (no provider usage yet)");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

async function showReportUi(lines: string[], ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		// Print mode / RPC without UI: dump to stderr-friendly notify
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	await ctx.ui.custom<undefined>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));

		container.addChild(border);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Context Usage")), 1, 0),
		);
		container.addChild(new Text("", 1, 0));
		for (const line of lines) {
			container.addChild(new Text(line, 1, 0));
		}
		container.addChild(new Text("", 1, 0));
		container.addChild(
			new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
		);
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description:
			"Report context-window usage: system prompt, user messages, tool calls+results, cache",
		handler: async (_args, ctx) => {
			const breakdown = buildBreakdown(ctx);
			const lines = buildReportLines(breakdown);
			await showReportUi(lines, ctx);
		},
	});
}
