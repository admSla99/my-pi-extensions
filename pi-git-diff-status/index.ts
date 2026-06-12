/**
 * Git Diff Status Line
 *
 * Shows added/removed line counts (and changed file count) for the current
 * working tree vs HEAD, in the footer status line.
 *
 * Baseline:  HEAD (all uncommitted changes)
 * Scope:     staged + unstaged + untracked files
 * Format:    +12 -3 (~4 files)
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "git-diff";
const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout;
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

interface DiffStats {
	added: number;
	removed: number;
	files: number;
}

async function computeStats(cwd: string): Promise<DiffStats | null> {
	if (!(await isGitRepo(cwd))) return null;

	let added = 0;
	let removed = 0;
	const changedFiles = new Set<string>();

	// Tracked changes (staged + unstaged) vs HEAD.
	// If there is no HEAD yet (fresh repo), fall back to the empty tree.
	let hasHead = true;
	try {
		await git(cwd, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		hasHead = false;
	}

	if (hasHead) {
		try {
			const numstat = await git(cwd, ["diff", "--numstat", "HEAD"]);
			for (const line of numstat.split("\n")) {
				if (!line.trim()) continue;
				const [a, r, ...rest] = line.split("\t");
				const path = rest.join("\t");
				if (path) changedFiles.add(path);
				if (a !== "-") added += Number(a) || 0;
				if (r !== "-") removed += Number(r) || 0;
			}
		} catch {
			// ignore
		}
	}

	// Untracked files: count their lines as additions.
	try {
		const others = await git(cwd, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		]);
		const files = others.split("\0").filter(Boolean);
		for (const file of files) {
			changedFiles.add(file);
			try {
				const buf = await readFile(join(cwd, file));
				if (buf.includes(0)) continue; // skip binary files
				const text = buf.toString("utf8");
				if (text.length === 0) continue;
				// line count = number of newlines, +1 if no trailing newline
				let nl = 0;
				for (let i = 0; i < text.length; i++) {
					if (text.charCodeAt(i) === 10) nl++;
				}
				added += text.endsWith("\n") ? nl : nl + 1;
			} catch {
				// ignore unreadable files
			}
		}
	} catch {
		// ignore
	}

	return { added, removed, files: changedFiles.size };
}

export default function (pi: ExtensionAPI) {
	let updating = false;

	async function refresh(ctx: {
		cwd: string;
		ui: { setStatus: (id: string, text?: string) => void; theme: any };
	}) {
		if (updating) return;
		updating = true;
		try {
			const stats = await computeStats(ctx.cwd);
			const theme = ctx.ui.theme;
			if (!stats) {
				ctx.ui.setStatus(STATUS_ID, undefined);
				return;
			}
			if (stats.added === 0 && stats.removed === 0) {
				ctx.ui.setStatus(STATUS_ID, theme.fg("dim", "±0"));
				return;
			}
			const plus = theme.fg("success", `+${stats.added}`);
			const minus = theme.fg("error", `-${stats.removed}`);
			const files = theme.fg(
				"dim",
				` (~${stats.files} file${stats.files === 1 ? "" : "s"})`,
			);
			ctx.ui.setStatus(STATUS_ID, `${plus} ${minus}${files}`);
		} finally {
			updating = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx as any);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx as any);
	});

	pi.on("tool_result", async (event, ctx) => {
		const t = (event as any).toolName;
		if (t === "edit" || t === "write" || t === "bash") {
			await refresh(ctx as any);
		}
	});
}
