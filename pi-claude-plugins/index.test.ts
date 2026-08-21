import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	activeInstall,
	loadState,
	resolveProjectPath,
	saveState,
	scopeLabel,
	type Plugin,
	type State,
} from "./index.ts";

const plugin: Plugin = {
	id: "demo@marketplace",
	name: "demo",
	marketplace: "marketplace",
	installs: [{
		scope: "local",
		projectPath: "/projects/original",
		installPath: "/cache/demo",
	}],
};

const state = (scopes: State["scopes"] = {}): State => ({
	disabled: [],
	typesOff: {},
	scopes,
});

test("Pi scope overrides Claude scope without touching the registry", () => {
	assert.equal(activeInstall(plugin, "/projects/original/src", state())?.installPath, "/cache/demo");
	assert.equal(activeInstall(plugin, "/projects/other", state()), undefined);

	assert.equal(activeInstall(plugin, "/anywhere", state({ [plugin.id]: "global" }))?.installPath, "/cache/demo");
	assert.equal(scopeLabel(plugin, state({ [plugin.id]: "global" })), "pi:global");

	const projects = state({ [plugin.id]: ["/projects/one", "/projects/two"] });
	assert.equal(activeInstall(plugin, "/projects/two/src", projects)?.projectPath, "/projects/two");
	assert.equal(activeInstall(plugin, "/projects/three", projects), undefined);

	const nowhere = state({ [plugin.id]: [] });
	assert.equal(activeInstall(plugin, "/projects/original", nowhere), undefined);
	assert.equal(scopeLabel(plugin, nowhere), "pi:none");
});

test("state round-trip is isolated to the requested temporary path", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
	try {
		const statePath = join(dir, "state.json");
		const expected: State = {
			disabled: [plugin.id],
			typesOff: { [plugin.id]: ["commands"] },
			scopes: { [plugin.id]: ["/projects/one", "/projects/two"] },
		};
		saveState(expected, statePath);
		assert.deepEqual(loadState(statePath), expected);
		assert.match(readFileSync(statePath, "utf8"), /"scopes"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy state and project paths remain supported", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
	try {
		const statePath = join(dir, "legacy.json");
		writeFileSync(statePath, JSON.stringify({ disabled: [plugin.id], typesOff: {} }));
		assert.deepEqual(loadState(statePath).scopes, {});

		const project = join(dir, "project");
		mkdirSync(project);
		assert.equal(resolveProjectPath("project", dir), project);
		assert.throws(() => resolveProjectPath("missing", dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
