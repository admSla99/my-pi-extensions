# pi-claude-plugins

Use your **Claude Code plugins** (skills, commands, agents) from inside **pi** —
without hand-editing `settings.json`. Toggle which plugins are active with an
interactive `/plugins` UI.

## What it does

pi reads Claude Code's own plugin registry
(`~/.claude/plugins/installed_plugins.json`) and, for every enabled plugin,
wires its resources into pi automatically:

| Claude Code | pi | How |
|-------------|-----|-----|
| `skills/`   | skills | `resources_discover` → `skillPaths` |
| `commands/*.md` | prompt templates (`/name`) | `resources_discover` → `promptPaths` |
| `agents/*.md` | subagents | registered via the [`pi-subagents`](https://github.com/amosblomqvist/pi-subagents) hook |

No `settings.json` edits, no symlinks. Everything is derived from disk on each
load, so plugins you install/update **with Claude Code** show up in pi after a
reload.

`hooks/` are Claude-specific and are **not** ported.

## Scope

Claude Code installs each plugin with a scope, which this extension honors
against the current working directory:

| Claude scope | Loads in pi when |
|--------------|------------------|
| `user`       | always (global, all projects) |
| `project` / `local` | cwd is inside the plugin's `projectPath` |

So a plugin installed local to `~/Projects/foo` only contributes its
skills/commands/agents while you run pi inside `~/Projects/foo`; it stays out of
scope everywhere else. Because pi rediscovers resources per session, switching
projects (or `/reload`) re-applies scoping.

In the `/plugins` list the checkbox reflects this:

- `[x]` enabled **and** active in the current cwd
- `[-]` enabled but out of scope here (its project is elsewhere)
- `[ ]` disabled

Each row also shows the scope (`global`, or `local:~/Projects/foo`).

## Requirements

- Claude Code installed, with plugins under `~/.claude/plugins/`.
- Agents feature is optional: it only activates when the
  [`pi-subagents`](https://github.com/amosblomqvist/pi-subagents) extension is
  also loaded (it exposes the registration hook this extension uses). Skills and
  commands work without it.

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["../../work/my-pi-extensions/pi-claude-plugins"]
}
```

(or any path/npm/git spec pointing at this directory). Restart pi.

If you previously pointed `settings.json` `skills` at a Claude plugin cache
directory that is now managed here (e.g. a whole marketplace under
`~/.claude/plugins/cache/<marketplace>`), remove it to avoid duplicate
skill-name collisions. Cache directories that are **not** in
`installed_plugins.json` (skills you wired up by hand) are not managed by this
extension — keep those entries.

## Usage

```
/plugins
```

Opens an interactive list of every discovered Claude plugin:

- `↑`/`↓` (or `j`/`k`) — move
- `space` — enable/disable the plugin
- `enter` — save and reload resources
- `esc` — cancel

Each row shows which resource types the plugin provides
(`skills`, `cmds`, `agents:N`). Enabled by default; disabling a plugin drops its
skills/commands/agents on the next reload.

## State

Enable/disable choices live in `~/.pi/agent/claude-plugins-state.json`:

```json
{ "disabled": ["plugin-name@marketplace"] }
```

Anything not listed there is enabled. Delete the file to re-enable everything.

## Notes / limitations

- **Install/update** plugins with Claude Code; this extension only consumes and
  toggles what Claude Code has installed.
- Subagent model: Claude agent `model:` values don't map cleanly to pi model
  ids, so ported agents use one default model
  (`anthropic/claude-sonnet-4-6`). Edit the agent's `.md` or the
  `DEFAULT_AGENT_MODEL` constant to change it.
- Agent tool names are mapped Claude→pi (`Read`→`read`, `Glob`→`find`, …);
  unmappable tools are dropped.
