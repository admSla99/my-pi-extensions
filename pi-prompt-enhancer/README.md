# pi-prompt-enhancer

A **minimal**, fully configurable prompt rewriter for [Pi](https://github.com/earendil-works/pi-mono).

You write a rough draft in the Pi editor, press `Alt+E` (or run `/pe`), and the extension rewrites it with one of your prompt-engineering techniques — auto-picking the right one based on keywords in the draft, with GPT-style and Claude-style guidance baked in.

Compared to `pi-promptsmith` this extension is intentionally tiny (~1000 LOC, 8 source files, flat layout) and gives you **direct control over the prompt techniques** via plain Markdown files.

## Highlights

- **Markdown templates** in `~/.pi/agent/pi-prompt-enhancer/` — one file per technique. Edit, add, remove freely.
- **Keyword-based auto-picker** (`implement` → `implement.md`, `fix bug` → `debug.md`, …) with a fallback picker UI when nothing matches.
- **GPT / Claude family branching** — each template has shared instructions plus optional GPT-specific and Claude-specific sections. The family is auto-detected from your active model (overridable).
- **Configurable enhancer model** — use the active session model or pin a specific provider/id.
- **Notifications**, **undo**, **cancellable** rewrite (`Esc` during the loader).
- **Draft-language preservation** — even though the prompt-engineering templates are in English, the rewritten prompt is forced back into the language of your draft (Slovak in → Slovak out, German in → German out, …). Toggle with `/pe language off`.
- **Zero runtime dependencies** beyond Pi itself. No YAML parser, no template engine.

## Install

```bash
pi install npm:pi-prompt-enhancer
# or run once without installing:
pi -e npm:pi-prompt-enhancer
```

Or load the local repo:

```bash
pi -e ./index.ts
```

On first run the extension seeds 8 default templates into `~/.pi/agent/pi-prompt-enhancer/`. They are yours to edit; the extension never overwrites existing files.

## Usage

1. Type a rough draft in the Pi editor, e.g. _"add dark mode to settings"_.
2. Press `Alt+E` (or run `/pe`).
3. The extension scans the draft for keywords (`add` → `implement.md`), builds the prompt for the active model's family, calls the enhancer model, and replaces the editor text with the rewrite.
4. If no keyword matches, you get a picker. Pick or press `Esc` to cancel.
5. Don't like the rewrite? Run `/pe undo`.

## Commands

| Command | Description |
| --- | --- |
| `/pe` | Enhance the current editor draft |
| `/pe pick` | Force the picker, skipping keyword auto-match |
| `/pe undo` | Restore the previous draft |
| `/pe status` | Show current configuration |
| `/pe list` | List discovered templates and their keywords |
| `/pe reload` | Re-read templates from disk after editing |
| `/pe family auto\|gpt\|claude` | Force a target family (default: auto) |
| `/pe fallback gpt\|claude` | Family used when auto cannot classify the model |
| `/pe default <id>` | Template used when no keyword matches and UI is unavailable |
| `/pe model active` | Use the current session model for rewriting (default) |
| `/pe model fixed <provider>/<id>` | Pin a specific model for rewriting |
| `/pe notify on\|off` | Toggle the "Enhanced with X" notification |
| `/pe language on\|off` | Preserve the draft's natural language in the rewrite (default: on) |
| `/pe reset` | Restore default settings |

Settings live in `~/.pi/agent/pi-prompt-enhancer-settings.json`.

## Default keyword routing

| Template | Triggers on |
| --- | --- |
| `implement.md` | implement, add, build, create, support, integrate, wire up |
| `debug.md` | debug, fix, bug, broken, error, crash, fails, failing, stuck, hangs |
| `review.md` | review, audit, findings, code review, look over |
| `refactor.md` | refactor, cleanup, simplify, restructure, reorganize, dedupe |
| `explain.md` | explain, how, why, walk me through, help me understand |
| `plan.md` | plan, design, architecture, approach, strategy, roadmap |
| `research.md` | research, investigate, compare, evaluate, spike, look up |
| `general.md` | (no keywords — used as the fallback) |

First whole-word match wins; templates are scanned in alphabetic file order. If two templates could match, the one that comes first by filename is used.

## Writing your own templates

A template is a Markdown file with frontmatter and named sections:

```md
---
name: chain-of-thought
keywords: [reason, step by step, think through]
---

## system

You are an expert prompt rewriter. Rewrite the draft so that the agent
reasons step-by-step before producing the final answer.

## system.gpt

Use plain prose and decision rules; lead with the desired outcome.

## system.claude

Use <thinking> and <answer> XML sections to structure the reasoning.

## user

Rewrite the following draft so the model thinks step-by-step:

<draft>
{{draft}}
</draft>
```

Required sections:

- `## system` — shared system prompt
- `## user` — must include `{{draft}}`

Optional sections:

- `## system.gpt` — appended to system prompt when the active model is GPT-family
- `## system.claude` — appended when the active model is Claude-family

Placeholders inside `## user`:

- `{{draft}}` — the editor draft (required)
- `{{family}}` — `gpt` or `claude`

After editing files, run `/pe reload`.

## How family detection works

The extension classifies the active model from `ctx.model.provider` / `ctx.model.id`:

- `anthropic` or id starting with `claude` → `claude`
- `moonshot`, ids containing `kimi` → `claude` (they follow Anthropic-style prompting)
- `openai`, `openai-codex`, ids starting with `gpt`, `o1`-`o9` → `gpt`
- anything else → `settings.fallbackFamily` (default `gpt`)

You can override with `/pe family gpt` or `/pe family claude`.

## How it works under the hood

The "rewrite" is a single LLM completion call (`complete()` from `@earendil-works/pi-ai`) — not a sub-agent with tools. The system prompt is `template.systemShared + template.system{Gpt|Claude}`, the user message is `template.userTemplate` with `{{draft}}` substituted. The response is whatever text the model returns, trimmed. No sentinel parsing, no retry — if the model returns empty, you see an error and the editor is left untouched.

### Draft-language preservation

When `preserveDraftLanguage` is on (default), the extension appends a strong language-preservation directive in two places before the request is sent:

1. At the end of the system prompt — a multi-line rule telling the model to detect the draft's language and reply in exactly that language, while leaving technical tokens (file paths, identifiers, commands, error messages) untouched.
2. Right after the substituted `{{draft}}` block in the user message — a one-line reminder that wins out over earlier English context.

Detection is delegated to the LLM (works for any language). This way the prompt-engineering templates can stay in English without affecting the output language. Disable with `/pe language off` if you want the model free to translate.

## Runtime support

- **Interactive TUI** — full support
- **RPC / print modes** — `/pe status` and `/pe list` work, but in-place rewriting is disabled (cannot read the editor)

## Why not `pi-promptsmith`?

`pi-promptsmith` is a great, more opinionated package: intent classifier, execution-contract compiler, settings UI, status bar, auto-send, sentinel parser with retry, etc. (~5400 LOC).

This extension takes the opposite approach: minimal core, **techniques live in user-owned Markdown files**, and you decide what each technique tells the model to do. If you want a fully-featured rewriter out of the box, use Promptsmith. If you want to engineer your own prompt techniques and keep the moving parts small, this is for you.

## Development

```bash
pnpm install   # or npm install
pnpm run typecheck
pi -e ./index.ts
```

## License

MIT
