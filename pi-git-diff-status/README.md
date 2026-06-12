# pi-git-diff-status

A Pi status-line extension that shows how many lines changed in the current
working tree, based on git.

```
+12 -3 (~4 files)
```

- Green `+N` — added lines
- Red `-N` — removed lines
- Dim `(~N files)` — number of changed files

When the tree is clean it shows a dim `±0`. Outside a git repository the status
is hidden.

## What it measures

- **Baseline:** `HEAD` — i.e. all uncommitted changes.
- **Scope:** staged + unstaged changes (`git diff --numstat HEAD`) plus
  **untracked** files (their lines are counted as additions; binary files are
  skipped).

## When it refreshes

- on `session_start`
- on `turn_end`
- after `edit`, `write`, and `bash` tool calls (`tool_result`)

A concurrency guard prevents overlapping git invocations.

## Colors

Colors are **not** hardcoded. The extension uses the theme's semantic color
roles via `ctx.ui.theme.fg(...)`:

| Role      | Used for        |
|-----------|-----------------|
| `success` | `+N` added      |
| `error`   | `-N` removed    |
| `dim`     | file count, `±0`|

The actual hex/ANSI values come from the **active theme**, so the status line
automatically follows whatever theme you use. To change the colors, edit the
theme (`~/.pi/agent/themes/*.json`), not this extension.

## Usage

Load ad-hoc:

```bash
pi -e ./pi-git-diff-status/index.ts
```

Or install system-wide:

```bash
pi install /absolute/path/to/pi-git-diff-status
```
