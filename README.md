# my-pi-extensions

Personal pi extensions for [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

This repo is an **npm workspace monorepo**. Each `pi-*/` subdirectory is an independent, separately-publishable Pi extension package, but they share a single root `package-lock.json` and a single hoisted `node_modules/`.

## Dev setup

Install all extensions in one shot from the repo root:

```bash
npm install
```

Run all available checks across every workspace:

```bash
npm run typecheck
```

## Using an extension locally

Load an extension ad-hoc into a Pi session:

```bash
pi -e ./pi-prompt-enhancer/index.ts
```

Or install it system-wide:

```bash
pi install /absolute/path/to/pi-prompt-enhancer
```

Each extension's `package.json` is the source of truth for its own peer/dev dependencies — `pi install` and `npm publish` from inside a sub-folder still work as expected.

## Extensions

- **[pi-tmux-notify/](./pi-tmux-notify)** — GNOME desktop notifications with tmux click-to-jump.
- **[pi-prompt-enhancer/](./pi-prompt-enhancer)** — Minimal, configurable prompt rewriter. `Alt+E` / `/pe` rewrites the editor draft using Markdown-defined techniques, with GPT/Claude family branching and draft-language preservation.
- **[pi-context-report/](./pi-context-report)** — `/context` command reporting context-window usage (system prompt / user / tool calls + results / cache) for the current session.
- **[pi-git-diff-status/](./pi-git-diff-status)** — status-line indicator showing `+added -removed (~N files)` for the working tree vs HEAD, including untracked files.

## Adding a new extension

1. Create the folder, e.g. `pi-myextension/` with its own `package.json` and `tsconfig.json`.
2. Add the folder name to the `workspaces` array in the root `package.json`.
3. `npm install` at the repo root.
