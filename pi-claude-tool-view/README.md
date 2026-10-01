# pi-claude-tool-view

Claude Code–style rendering for Pi's built-in tools. Each tool call is a single line with a one-line result summary:

```
● Bash(cd ~/Projects/agentix && gh pr edit 313 --body-file /tmp/pr.md …)
  ⎿  6 lines of output (ctrl+o to expand)

● Write(/tmp/agentix-pdfk-agentix-pr.md)
  ⎿  Wrote 22 lines to /tmp/agentix-pdfk-agentix-pr.md (ctrl+o to expand)

● Update(src/index.ts)
  ⎿  Updated with 3 additions and 1 removal (ctrl+o to expand)
```

The dot is grey while running, green on success, red on error. On error the summary shows the last line of the output (for bash, `Command exited with code N`).

## Expanding

`ctrl+o` (Pi's `app.tools.expand` keybinding) toggles every tool row between the compact line and Pi's original view — full command, file content, diff, output, and timing — in the usual colored box. Clicking a row toggles it too.

## Tools

| Tool | Line |
|---|---|
| `bash` | `Bash(command)` → line count of output |
| `read` | `Read(path:from-to)` → lines read |
| `write` | `Write(path)` → lines written |
| `edit` | `Update(path)` → additions / removals |
| `grep` | `Search(pattern: "…", path: …)` → matching lines |
| `find` | `Glob(pattern in path)` → files found |
| `ls` | `List(path)` → entries |

Only rendering changes. Each call runs a fresh built-in tool definition with the session's cwd and the `shellPath`, `shellCommandPrefix`, and `images.autoResize` settings. Tool activation follows Pi's defaults: `grep`, `find`, and `ls` stay inactive unless enabled with `--tools` or `defaultTools`.

Tools from other extensions and MCP servers keep their own rendering.

## Install

```bash
pi -e ./pi-claude-tool-view/index.ts        # try it in one session
pi install /absolute/path/to/pi-claude-tool-view
```

Requires Pi 0.99 or newer (`pi.getSettings()`).
