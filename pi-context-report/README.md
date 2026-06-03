# pi-context-report

Pi extension that registers a `/context` slash command. It reports
context-window usage for the **current session**, broken down by category.

## What it shows

For the active session branch:

| Category | What it counts |
|----------|----------------|
| **System prompt** | Pi's current effective system prompt (`ctx.getSystemPrompt()`) |
| **User messages** | All `role: "user"` messages |
| **Tool calls + results** | `toolCall` content blocks from assistant messages + all `toolResult` messages + `bashExecution` entries |
| **Other (assistant/summaries)** | Assistant `text` / `thinking` blocks, branch summaries, compaction summaries, custom messages |
| **Cache read / write** | `cacheRead` / `cacheWrite` from the most recent non-aborted assistant `usage` |

Each row shows tokens and the percentage of the current model's context
window. The footer also prints the model name, context window size, and
the provider-reported context usage (from `ctx.getContextUsage()`) for
cross-reference.

### Token estimation

Content tokens are estimated with the same chars/4 heuristic pi uses
internally for `estimateTokens` (4800 chars per image). Cache numbers are
taken verbatim from the assistant message `usage` field returned by the
provider, so they are exact, not estimates.

`Sum (estimated)` may differ from `Reported usage` because they measure
different things:

- *Sum* is a static chars/4 estimate of the messages currently on the
  branch + the system prompt string.
- *Reported usage* is what the provider charged on the last call,
  including tool / system payload framing, cached prefix tokens, etc.

## Install

From the repo root:

```bash
cd pi-context-report
npm install
pi install /home/sla2mlv/work/my-pi-extensions/pi-context-report
```

Or load ad-hoc for one session:

```bash
pi -e /home/sla2mlv/work/my-pi-extensions/pi-context-report/index.ts
```

## Usage

In an interactive pi session, type:

```
/context
```

A bordered overlay pops up with the breakdown. Press **Enter** or **Esc**
to close.

In print mode (`-p`) the report is emitted via `ctx.ui.notify` since
there's no interactive UI to draw the overlay into.

## Why not just `/session`?

`/session` shows totals (input / output / cache / cost) as reported by
the provider. `/context` shows where those tokens *come from*: how much
is system prompt, how much is the user typing, how much is tool I/O.
That's the breakdown you need when you're trying to figure out *what* to
trim or `/compact`.
