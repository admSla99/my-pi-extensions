import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MODEL = "openai/gpt-5.6-luna";
const MAX_DIFF_CHARS = 48_000;

export default function (pi: ExtensionAPI) {
	let running = false;

	pi.registerCommand("ship", {
		description: "Stage all changes, commit, and push; optional argument is the commit message",
		handler: async (args, ctx) => {
			if (running) {
				ctx.ui.notify("Ship is already running", "warning");
				return;
			}

			running = true;
			ctx.ui.setStatus("ship", "waiting…");
			try {
				await ctx.waitForIdle();
				ctx.ui.setStatus("ship", "staging…");
				await ship(pi, ctx, args.trim());
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				running = false;
				ctx.ui.setStatus("ship", undefined);
			}
		},
	});
}

async function ship(pi: ExtensionAPI, ctx: ExtensionCommandContext, suppliedMessage: string) {
	await git(pi, ctx.cwd, ["rev-parse", "--is-inside-work-tree"]);
	const remote = await getRemote(pi, ctx.cwd);
	const base = await getBase(pi, ctx.cwd, remote);
	let branch = (await git(pi, ctx.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
	const onBase = branch === base.name;
	const status = await git(pi, ctx.cwd, ["status", "--porcelain"]);
	let message: string | undefined;

	if (status.trim()) {
		await git(pi, ctx.cwd, ["add", "-A"]);
		const staged = await pi.exec("git", ["diff", "--cached", "--quiet"], { cwd: ctx.cwd });
		if (staged.code === 0) {
			ctx.ui.notify("Nothing to commit after staging", "info");
			return;
		}
		if (staged.code !== 1) throw new Error(staged.stderr.trim() || "Could not inspect staged changes");

		ctx.ui.setStatus("ship", suppliedMessage ? "committing…" : `message: ${MODEL}…`);
		message = suppliedMessage || (await generateCommitMessage(pi, ctx.cwd));
		if (onBase) branch = await moveFromBase(pi, ctx.cwd, base, message);
		await git(pi, ctx.cwd, ["commit", "-m", message]);
	} else if (onBase) {
		const ahead = Number((await git(pi, ctx.cwd, ["rev-list", "--count", `${base.ref}..HEAD`])).trim());
		if (ahead === 0) {
			ctx.ui.notify(`Nothing to ship on ${base.name}`, "info");
			return;
		}
		message = (await git(pi, ctx.cwd, ["log", "-1", "--pretty=%s"])).trim();
		branch = await moveFromBase(pi, ctx.cwd, base, message);
	}

	ctx.ui.setStatus("ship", "pushing…");
	await push(pi, ctx.cwd, remote);
	ctx.ui.setStatus("ship", "pull request…");
	const pr = await ensurePullRequest(pi, ctx.cwd, base.name, branch);
	const action = message ? `Committed and pushed ${branch}: ${message}` : `Pushed ${branch}`;
	ctx.ui.notify(`${action}; ${pr.created ? "opened" : "using"} ${pr.url}`, "info");
}

async function getRemote(pi: ExtensionAPI, cwd: string): Promise<string> {
	const remotes = (await git(pi, cwd, ["remote"]))
		.split("\n")
		.map((remote) => remote.trim())
		.filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
	if (!remote) throw new Error("No unambiguous remote found");
	return remote;
}

async function getBase(pi: ExtensionAPI, cwd: string, remote: string): Promise<{ name: string; ref: string }> {
	const symbolic = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], {
		cwd,
	});
	if (symbolic.code === 0) {
		const ref = symbolic.stdout.trim();
		return { name: ref.slice(remote.length + 1), ref };
	}

	for (const name of ["main", "master"]) {
		const ref = `${remote}/${name}`;
		const exists = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], { cwd });
		if (exists.code === 0) return { name, ref };
	}
	throw new Error(`Cannot determine the default branch for ${remote}`);
}

async function moveFromBase(
	pi: ExtensionAPI,
	cwd: string,
	base: { name: string; ref: string },
	message: string,
): Promise<string> {
	const stem = branchStem(message);
	const remote = base.ref.slice(0, base.ref.indexOf("/"));
	let branch = stem;
	for (let suffix = 2; await refExists(pi, cwd, remote, branch); suffix++) branch = `${stem}-${suffix}`;
	await git(pi, cwd, ["switch", "-c", branch]);
	await git(pi, cwd, ["branch", "--force", base.name, base.ref]);
	return branch;
}

function branchStem(message: string): string {
	const conventional = message.match(/^(feat|fix|chore|docs|refactor|test|perf|build|ci)(?:\([^)]*\))?!?:\s*(.+)$/i);
	const prefix = conventional?.[1].toLowerCase() ?? "feat";
	const subject = conventional?.[2] ?? message;
	const slug = subject
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48)
		.replace(/-$/g, "");
	return `${prefix}/${slug || "changes"}`;
}

async function refExists(pi: ExtensionAPI, cwd: string, remote: string, branch: string): Promise<boolean> {
	for (const ref of [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]) {
		const result = await pi.exec("git", ["show-ref", "--verify", "--quiet", ref], { cwd });
		if (result.code === 0) return true;
		if (result.code !== 1) throw new Error(result.stderr.trim() || `Could not inspect ${ref}`);
	}
	return false;
}

async function push(pi: ExtensionAPI, cwd: string, remote: string) {
	const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd });
	if (upstream.code === 0) await git(pi, cwd, ["push"]);
	else await git(pi, cwd, ["push", "--set-upstream", remote, "HEAD"]);
}

async function ensurePullRequest(
	pi: ExtensionAPI,
	cwd: string,
	base: string,
	branch: string,
): Promise<{ url: string; created: boolean }> {
	const existing = await pi.exec(
		"gh",
		["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "url", "--jq", '.[0].url // ""'],
		{ cwd },
	);
	if (existing.code !== 0) throw new Error(existing.stderr.trim() || "Could not query pull requests");
	const url = existing.stdout.trim();
	if (url) return { url, created: false };

	const created = await pi.exec("gh", ["pr", "create", "--fill", "--base", base, "--head", branch], { cwd });
	if (created.code !== 0) throw new Error(created.stderr.trim() || "Could not create pull request");
	return { url: created.stdout.trim(), created: true };
}

async function generateCommitMessage(pi: ExtensionAPI, cwd: string): Promise<string> {
	const [recent, stat, names, diff] = await Promise.all([
		git(pi, cwd, ["log", "-8", "--pretty=%s"]),
		git(pi, cwd, ["diff", "--cached", "--stat"]),
		git(pi, cwd, ["diff", "--cached", "--name-status"]),
		git(pi, cwd, ["diff", "--cached", "--no-ext-diff", "--unified=2"]),
	]);
	const clippedDiff = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
	const prompt = `Write exactly one concise Git commit subject for these staged changes. Match the style of the recent subjects. Explain why, not a file tour. No quotes, Markdown, body, or commentary.\n\nRecent subjects:\n${recent}\n\nStat:\n${stat}\n\nFiles:\n${names}\n\nDiff:\n${clippedDiff}`;
	const output = await runPi(prompt, cwd);
	const message = output
		.trim()
		.split(/\r?\n/)
		.find(Boolean)
		?.replace(/^[\s"'`]+|[\s"'`]+$/g, "");
	if (!message) throw new Error(`${MODEL} returned an empty commit message`);
	return message.slice(0, 200);
}

function runPi(prompt: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"pi",
			[
				"--print",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-tools",
				"--model",
				MODEL,
				"--thinking",
				"off",
				"--system-prompt",
				"Return exactly one Git commit subject and nothing else.",
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			error ? reject(error) : resolve(stdout);
		};
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`${MODEL} timed out while generating the commit message`));
		}, 60_000);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => finish(error));
		child.on("close", (code) =>
			code === 0 ? finish() : finish(new Error(`${MODEL} failed: ${stderr.trim() || `exit ${code}`}`)),
		);
		child.stdin.end(prompt);
	});
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	return result.stdout;
}
