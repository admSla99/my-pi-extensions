# pi-git-statusline

A Pi status-line extension that shows how many lines changed, based on git.
It has up to three segments:

```
+12 -3 (~4 files) │ ⎇ +120 -45 (~9 files) │ PR #123
└── working tree vs HEAD ┘   └── branch vs base ┘   └ open PR ┘
```

- Green `+N` — added lines
- Red `-N` — removed lines
- Dim `(~N files)` — number of changed files

Outside a git repository the status is hidden.

## What it measures

### Segment 1 — uncommitted changes vs HEAD

- **Baseline:** `HEAD` — i.e. all uncommitted changes.
- **Scope:** staged + unstaged changes (`git diff --numstat HEAD`) plus
  **untracked** files (their lines are counted as additions; binary files are
  skipped).
- Shows a dim `±0` when the working tree is clean.

### Segment 2 — branch vs base (committed only)

- **Base:** auto-detected: `origin/HEAD` → `origin/main`/`main` →
  `origin/master`/`master`.
- **Scope:** committed changes the branch introduces
  (`git diff --numstat <base>...HEAD`, three-dot / merge-base). Untracked and
  uncommitted changes are **not** counted here — they live in segment 1.
- **Hidden** when there is nothing ahead of base (e.g. you are on the base
  branch itself, or your branch tip equals the base tip).

### Segment 3 — open PR number

- Shows `PR #123` when an **open** pull request exists for the current branch.
- Looked up via the GitHub CLI: `gh pr list --head <branch> --state open`.
- **Hidden** when there is no open PR, `gh` is unavailable / not authenticated,
  or you are on the base branch.
- Requires the [`gh`](https://cli.github.com/) CLI, authenticated for the
  repo's host (`gh auth status`). The lookup is cached per branch (5 min TTL)
  and runs with a timeout, so the status line never blocks on the network.

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
pi -e ./pi-git-statusline/index.ts
```

Or install system-wide:

```bash
pi install /absolute/path/to/pi-git-statusline
```
