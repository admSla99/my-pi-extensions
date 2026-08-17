import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MODEL = "openai/gpt-5.6-luna";
const MAX_DIFF_CHARS = 48_000;

interface ShipMetadata {
	commit: string;
	branch: string;
	title: string;
	body: string;
}

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
	let metadata: ShipMetadata | undefined;
	let existingPr: string | undefined;

	if (status.trim()) {
		await git(pi, ctx.cwd, ["add", "-A"]);
		const staged = await pi.exec("git", ["diff", "--cached", "--quiet"], { cwd: ctx.cwd });
		if (staged.code === 0) {
			ctx.ui.notify("Nothing to commit after staging", "info");
			return;
		}
		if (staged.code !== 1) throw new Error(staged.stderr.trim() || "Could not inspect staged changes");

		if (suppliedMessage && !onBase) existingPr = await findPullRequest(pi, ctx.cwd, branch);
		if (!suppliedMessage || onBase || !existingPr) {
			ctx.ui.setStatus("ship", `metadata: ${MODEL}…`);
			metadata = await generateShipMetadata(pi, ctx.cwd, base.ref, suppliedMessage || undefined);
		}
		message = suppliedMessage || metadata?.commit;
		if (!message) throw new Error("Could not determine a commit message");
		if (onBase) branch = await moveFromBase(pi, ctx.cwd, base, metadata?.branch ?? branchStem(message));
		await git(pi, ctx.cwd, ["commit", "-m", message]);
	} else if (onBase) {
		const ahead = Number((await git(pi, ctx.cwd, ["rev-list", "--count", `${base.ref}..HEAD`])).trim());
		if (ahead === 0) {
			ctx.ui.notify(`Nothing to ship on ${base.name}`, "info");
			return;
		}
		ctx.ui.setStatus("ship", `metadata: ${MODEL}…`);
		metadata = await generateShipMetadata(pi, ctx.cwd, base.ref);
		message = (await git(pi, ctx.cwd, ["log", "-1", "--pretty=%s"])).trim();
		branch = await moveFromBase(pi, ctx.cwd, base, metadata.branch);
	}

	ctx.ui.setStatus("ship", "pushing…");
	await push(pi, ctx.cwd, remote);
	ctx.ui.setStatus("ship", "pull request…");
	existingPr ??= await findPullRequest(pi, ctx.cwd, branch);
	if (!existingPr) {
		metadata ??= await generateShipMetadata(pi, ctx.cwd, base.ref, message);
		existingPr = await createPullRequest(pi, ctx.cwd, base.name, branch, metadata);
	}
	const action = message ? `Committed and pushed ${branch}: ${message}` : `Pushed ${branch}`;
	ctx.ui.notify(`${action}; ${existingPr}`, "info");
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
	suggestedBranch: string,
): Promise<string> {
	const stem = normalizeBranch(suggestedBranch);
	const remote = base.ref.slice(0, base.ref.indexOf("/"));
	let branch = stem;
	for (let suffix = 2; await refExists(pi, cwd, remote, branch); suffix++) branch = `${stem}-${suffix}`;
	await git(pi, cwd, ["switch", "-c", branch]);
	await git(pi, cwd, ["branch", "--force", base.name, base.ref]);
	return branch;
}

function branchStem(message: string): string {
	const conventional = message.match(/^(feat|fix|chore|docs|refactor|test|perf|build|ci)(?:\([^)]*\))?!?:\s*(.+)$/i);
	return `${conventional?.[1].toLowerCase() ?? "feat"}/${conventional?.[2] ?? message}`;
}

function normalizeBranch(suggestion: string): string {
	const [rawPrefix, ...rest] = suggestion.replace(/^refs\/heads\//, "").split("/");
	const prefix = /^(feat|fix|chore|docs|refactor|test|perf|build|ci)$/i.test(rawPrefix) ? rawPrefix.toLowerCase() : "feat";
	const slug = (rest.join("-") || rawPrefix)
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24)
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

async function findPullRequest(pi: ExtensionAPI, cwd: string, branch: string): Promise<string | undefined> {
	const existing = await pi.exec(
		"gh",
		["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "url", "--jq", '.[0].url // ""'],
		{ cwd },
	);
	if (existing.code !== 0) throw new Error(existing.stderr.trim() || "Could not query pull requests");
	return existing.stdout.trim() || undefined;
}

async function createPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	base: string,
	branch: string,
	metadata: ShipMetadata,
): Promise<string> {
	const created = await pi.exec(
		"gh",
		["pr", "create", "--base", base, "--head", branch, "--title", metadata.title, "--body", metadata.body],
		{ cwd },
	);
	if (created.code !== 0) throw new Error(created.stderr.trim() || "Could not create pull request");
	return created.stdout.trim();
}

async function generateShipMetadata(
	pi: ExtensionAPI,
	cwd: string,
	baseRef: string,
	forcedCommit?: string,
): Promise<ShipMetadata> {
	const [recent, stagedStat, stagedNames, stagedDiff, branchStat, branchNames, branchDiff, template] =
		await Promise.all([
			git(pi, cwd, ["log", "-8", "--pretty=%s"]),
			git(pi, cwd, ["diff", "--cached", "--stat"]),
			git(pi, cwd, ["diff", "--cached", "--name-status"]),
			git(pi, cwd, ["diff", "--cached", "--no-ext-diff", "--unified=2"]),
			git(pi, cwd, ["diff", "--stat", `${baseRef}...HEAD`]),
			git(pi, cwd, ["diff", "--name-status", `${baseRef}...HEAD`]),
			git(pi, cwd, ["diff", "--no-ext-diff", "--unified=2", `${baseRef}...HEAD`]),
			readPullRequestTemplate(pi, cwd),
		]);
	const combinedDiff = `Already committed on the branch:\n${branchDiff || "(none)"}\n\nStaged now:\n${stagedDiff || "(none)"}`;
	const clippedDiff =
		combinedDiff.length > MAX_DIFF_CHARS
			? `${combinedDiff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`
			: combinedDiff;
	const prompt = `Analyze the complete change and return one JSON object with string fields: commit, branch, title, body.

Rules:
- commit: concise Git subject matching recent repository style; explain intent, not a file tour.${forcedCommit ? ` Use exactly this value: ${JSON.stringify(forcedCommit)}.` : ""}
- branch: short conventional name such as feat/request-form-ui or fix/login-redirect; 2-4 meaningful words after the slash, no implementation inventory.
- title: clear pull-request title describing the user or developer outcome; 3-8 words, no conventional-commit prefix, no implementation inventory.
- body: meaningful Markdown description of why the change exists and its key behavior. Use a short Summary section and concise bullets. Mention testing only when the diff provides evidence. Never leave it empty.
- Return raw valid JSON only, with newlines in body escaped by JSON encoding.
${template ? `- Follow this repository PR template:\n${template.slice(0, 8_000)}\n` : ""}
Recent commit subjects:
${recent}

Changes already committed against ${baseRef}:
${branchStat || "(none)"}
${branchNames || "(none)"}

New staged changes:
${stagedStat || "(none)"}
${stagedNames || "(none)"}

Diff:
${clippedDiff}`;
	const output = await runPi(prompt, cwd);
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error(`${MODEL} returned invalid ship metadata`);

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		throw new Error(`${MODEL} returned invalid JSON ship metadata`);
	}
	const commit = forcedCommit || stringField(parsed, "commit");
	const title = stringField(parsed, "title").replace(/\s+/g, " ").slice(0, 90).trim();
	const body = stringField(parsed, "body").trim().slice(0, 8_000);
	return {
		commit: commit.replace(/[\r\n]+/g, " ").slice(0, 200).trim(),
		branch: normalizeBranch(stringField(parsed, "branch") || branchStem(commit)),
		title,
		body,
	};
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string" || !field.trim()) throw new Error(`${MODEL} returned no ${key}`);
	return field.trim();
}

async function readPullRequestTemplate(pi: ExtensionAPI, cwd: string): Promise<string> {
	const root = (await git(pi, cwd, ["rev-parse", "--show-toplevel"])).trim();
	for (const path of [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"]) {
		try {
			return await readFile(join(root, path), "utf8");
		} catch {
			// Try the next conventional location.
		}
	}
	return "";
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
				"Return exactly one valid JSON object and nothing else.",
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
			finish(new Error(`${MODEL} timed out while generating ship metadata`));
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
