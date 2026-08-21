# pi-claude-plugins

Use your **Claude Code plugins** (skills, commands, agents) from inside **pi** —
without hand-editing `settings.json`. Manage activation, resource types, and
Pi-specific project/global scopes with an interactive `/plugins` UI.

## What it does

pi reads Claude Code's own plugin registry
(`~/.claude/plugins/installed_plugins.json`) and, for every enabled plugin,
wires its resources into pi automatically:

| Claude Code | pi | How |
|-------------|-----|-----|
| `skills/`   | skills | `resources_discover` → `skillPaths` |
| `commands/*.md` | prompt templates (`/name`) | `resources_discover` → `promptPaths` |
| `agents/*.md` | subagents | registered via the [`pi-subagents`](https://github.com/amosblomqvist/pi-subagents) hook |

Plugin resources are derived from disk on each load, so plugins you
install/update **with Claude Code** show up in pi after a reload. Pi-specific
choices live in a separate state file.

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

Press `p` in `/plugins` to override that scope for Pi. A plugin can be global,
limited to one or more project directories, inactive everywhere, or reset to
its Claude scope. These overrides only control Pi resource loading; Claude's
registry and settings remain the installation source of truth.

In the `/plugins` list the checkbox reflects this:

- `[x]` enabled **and** active in the current cwd
- `[-]` enabled but out of scope here (its project is elsewhere)
- `[ ]` disabled

Each row also shows the scope. Overrides are prefixed with `pi:`, for example
`pi:global`, `pi:~/Projects/foo`, or `pi:none`.

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
- `space` — enable/disable the whole plugin
- `s` / `c` / `a` — toggle just **skills** / **commands** / **agents** for the
  selected plugin
- `p` — set the Pi scope: global, current/other/additional projects, no scope,
  or the original Claude scope
- `enter` — save and reload resources
- `esc` — cancel

Each row shows three badges `S C A` (skills / commands / agents):

- green uppercase (`S`) — provided and on
- red lowercase (`s`) — provided but turned off
- dim dot (`·`) — the plugin doesn't ship that type

So you can, for example, keep a plugin's skills while dropping its slash
commands (which become pi prompt templates) — handy when a plugin adds
`/commands` you never use. Everything is enabled by default; changes apply on
reload.

## State

Pi choices live in `~/.pi/agent/claude-plugins-state.json`:

```json
{
  "disabled": ["plugin-name@marketplace"],
  "typesOff": { "other-plugin@marketplace": ["commands"] },
  "scopes": {
    "global-plugin@marketplace": "global",
    "project-plugin@marketplace": ["/work/foo", "/work/bar"],
    "inactive-plugin@marketplace": []
  }
}
```

- `disabled` — whole plugins turned off.
- `typesOff` — per-plugin resource types turned off (`skills` / `commands` /
  `agents`).
- `scopes` — Pi scope overrides: `"global"`, project-root arrays, or an empty
  array for no active scope.

Anything not listed uses its default. Removing a `scopes` entry restores the
scope recorded by Claude Code; deleting the state file restores all defaults.

## Notes / limitations

- **Install/update** plugins with Claude Code; this extension only consumes and
  toggles what Claude Code has installed.
- Subagent model: Claude agent `model:` values don't map cleanly to pi model
  ids, so ported agents use one default model
  (`anthropic/claude-sonnet-4-6`). Edit the agent's `.md` or the
  `DEFAULT_AGENT_MODEL` constant to change it.
- Agent tool names are mapped Claude→pi (`Read`→`read`, `Glob`→`find`, …);
  unmappable tools are dropped.
