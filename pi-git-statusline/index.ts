/**
 * Git Status Line
 *
 * Footer status line with two segments:
 *
 *   +12 -3 (~4 files) │ ⎇ +120 -45 (~9)
 *   └── working tree vs HEAD ──┘   └── branch vs base ──┘
 *
 * Segment 1 — uncommitted changes vs HEAD:
 *   Baseline: HEAD (all uncommitted changes)
 *   Scope:    staged + unstaged + untracked files
 *
 * Segment 2 — committed changes the branch introduces vs its base:
 *   Base:     auto-detected (origin/HEAD → main → master)
 *   Scope:    committed only (git diff <base>...HEAD, three-dot / merge-base)
 *   Hidden when there is nothing ahead of base (e.g. you are on the base branch).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "git-statusline";
const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await git(cwd, args);
	} catch {
		return null;
	}
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const out = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return out?.trim() === "true";
}

interface DiffStats {
	added: number;
	removed: number;
	files: number;
}

/** Parse `git diff --numstat` output into added/removed line counts. */
function parseNumstat(numstat: string, files: Set<string>): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of numstat.split("\n")) {
		if (!line.trim()) continue;
		const [a, r, ...rest] = line.split("\t");
		const path = rest.join("\t");
		if (path) files.add(path);
		if (a !== "-") added += Number(a) || 0;
		if (r !== "-") removed += Number(r) || 0;
	}
	return { added, removed, files: files.size };
}

/** Segment 1: uncommitted changes (staged + unstaged + untracked) vs HEAD. */
async function computeWorkingStats(cwd: string): Promise<DiffStats> {
	const changedFiles = new Set<string>();
	let added = 0;
	let removed = 0;

	const hasHead = (await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])) != null;
	if (hasHead) {
		const numstat = await tryGit(cwd, ["diff", "--numstat", "HEAD"]);
		if (numstat) {
			const s = parseNumstat(numstat, changedFiles);
			added += s.added;
			removed += s.removed;
		}
	}

	// Untracked files: count their lines as additions.
	const others = await tryGit(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	if (others) {
		for (const file of others.split("\0").filter(Boolean)) {
			changedFiles.add(file);
			try {
				const buf = await readFile(join(cwd, file));
				if (buf.includes(0)) continue; // skip binary files
				const text = buf.toString("utf8");
				if (text.length === 0) continue;
				let nl = 0;
				for (let i = 0; i < text.length; i++) {
					if (text.charCodeAt(i) === 10) nl++;
				}
				added += text.endsWith("\n") ? nl : nl + 1;
			} catch {
				// ignore unreadable files
			}
		}
	}

	return { added, removed, files: changedFiles.size };
}

/** Resolve the base ref to diff a feature branch against. */
async function detectBase(cwd: string): Promise<string | null> {
	// 1) origin/HEAD → e.g. refs/remotes/origin/main
	const sym = await tryGit(cwd, [
		"symbolic-ref",
		"--quiet",
		"refs/remotes/origin/HEAD",
	]);
	if (sym?.trim()) {
		return sym.trim().replace(/^refs\/remotes\//, ""); // → origin/main
	}
	// 2) fallback: main, then master (prefer remote-tracking if present)
	for (const name of ["main", "master"]) {
		if ((await tryGit(cwd, ["rev-parse", "--verify", `origin/${name}`])) != null) {
			return `origin/${name}`;
		}
		if ((await tryGit(cwd, ["rev-parse", "--verify", name])) != null) {
			return name;
		}
	}
	return null;
}

/**
 * Segment 2: committed changes the current branch introduces vs base.
 * Returns null when there is nothing ahead of base (or no base / detached on base).
 */
async function computeBranchStats(
	cwd: string,
	base: string,
): Promise<DiffStats | null> {
	// Skip if HEAD is already contained in base (e.g. we're on the base branch).
	const mergeBase = (await tryGit(cwd, ["merge-base", base, "HEAD"]))?.trim();
	const head = (await tryGit(cwd, ["rev-parse", "HEAD"]))?.trim();
	const baseSha = (await tryGit(cwd, ["rev-parse", base]))?.trim();
	if (!mergeBase || !head) return null;
	if (head === baseSha) return null; // identical to base tip

	const numstat = await tryGit(cwd, ["diff", "--numstat", `${base}...HEAD`]);
	if (numstat == null) return null;

	const stats = parseNumstat(numstat, new Set<string>());
	if (stats.added === 0 && stats.removed === 0 && stats.files === 0) return null;
	return stats;
}

function fileLabel(n: number): string {
	return ` (~${n} file${n === 1 ? "" : "s"})`;
}

/** Short branch name for the base ref, e.g. origin/main → main. */
function baseShortName(base: string): string {
	return base.replace(/^origin\//, "");
}

async function currentBranch(cwd: string): Promise<string | null> {
	const b = (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
	if (!b || b === "HEAD") return null; // no branch / detached
	return b;
}

// Cache the (network) PR lookup per branch so frequent refreshes stay cheap.
const PR_TTL_MS = 5 * 60 * 1000;
interface PrCache {
	branch: string;
	number: number | null;
	at: number;
}
let prCache: PrCache | null = null;

/** Open PR number for `branch` via the GitHub CLI, or null. Cached with a TTL. */
async function getOpenPrNumber(
	cwd: string,
	branch: string,
): Promise<number | null> {
	const now = Date.now();
	if (prCache && prCache.branch === branch && now - prCache.at < PR_TTL_MS) {
		return prCache.number;
	}
	let number: number | null = null;
	try {
		const { stdout } = await exec(
			"gh",
			[
				"pr",
				"list",
				"--head",
				branch,
				"--state",
				"open",
				"--json",
				"number",
				"--limit",
				"1",
			],
			{ cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
		);
		const arr = JSON.parse(stdout) as Array<{ number: number }>;
		number = arr.length > 0 ? arr[0].number : null;
	} catch {
		number = null; // gh missing / not authed / timeout / error
	}
	prCache = { branch, number, at: now };
	return number;
}

export default function (pi: ExtensionAPI) {
	let updating = false;

	async function refresh(ctx: {
		cwd: string;
		ui: {
			setStatus: (id: string, text?: string) => void;
			theme: { fg: (role: string, text: string) => string };
		};
	}) {
		if (updating) return;
		updating = true;
		try {
			if (!(await isGitRepo(ctx.cwd))) {
				ctx.ui.setStatus(STATUS_ID, undefined);
				return;
			}
			const theme = ctx.ui.theme;
			const base = await detectBase(ctx.cwd);
			const branch = await currentBranch(ctx.cwd);

			// Segment 1: working tree vs HEAD.
			const wt = await computeWorkingStats(ctx.cwd);
			let seg1: string;
			if (wt.added === 0 && wt.removed === 0) {
				seg1 = theme.fg("dim", "±0");
			} else {
				seg1 =
					theme.fg("success", `+${wt.added}`) +
					" " +
					theme.fg("error", `-${wt.removed}`) +
					theme.fg("dim", fileLabel(wt.files));
			}

			const sep = theme.fg("dim", "│");
			let status = seg1;

			// Segment 2: branch vs base (committed only), hidden when empty.
			if (base) {
				const br = await computeBranchStats(ctx.cwd, base);
				if (br) {
					const seg2 =
						theme.fg("dim", "⎇ ") +
						theme.fg("success", `+${br.added}`) +
						" " +
						theme.fg("error", `-${br.removed}`) +
						theme.fg("dim", fileLabel(br.files));
					status = `${status} ${sep} ${seg2}`;
				}
			}

			// Segment 3: open PR number for the current branch (skip on base branch).
			if (branch && (!base || branch !== baseShortName(base))) {
				const pr = await getOpenPrNumber(ctx.cwd, branch);
				if (pr != null) {
					const seg3 =
						theme.fg("dim", "PR ") + theme.fg("accent", `#${pr}`);
					status = `${status} ${sep} ${seg3}`;
				}
			}

			ctx.ui.setStatus(STATUS_ID, status);
		} finally {
			updating = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx as never);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx as never);
	});

	pi.on("tool_result", async (event, ctx) => {
		const t = (event as { toolName?: string }).toolName;
		if (t === "edit" || t === "write" || t === "bash") {
			await refresh(ctx as never);
		}
	});
}
