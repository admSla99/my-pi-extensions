# pi-tmux-notify

Pi extension that sends GNOME desktop notifications when the agent finishes
or asks a question, with a "click to jump" action that focuses the tmux pane
hosting pi and raises the terminal window.

## Prerequisites

- Linux with **GNOME Shell** on **X11** (Ubuntu 22.04+ tested)
- `tmux` (pi must be running inside a tmux pane for click-to-jump to work)
- `xdotool` (`sudo apt install xdotool`)

If you're on Wayland, click-to-jump won't work (`xdotool` is X11-only). The
notification will still appear.

## Install

```bash
cd /path/to/my-pi-extensions/notify
npm install
pi install /absolute/path/to/my-pi-extensions/notify
```

Restart pi (or `/reload`) to load the extension.

## How it works

- **session_start** — captures the tmux pane id (`$TMUX_PANE`), tmux session
  name, and the X11 active window id (which is the terminal that just launched
  pi). Opens a session bus D-Bus connection to `org.freedesktop.Notifications`.

- **agent_end** — sends a notification "Agent complete — click to jump".

- **ask_user tool call** — sends a notification "Agent is asking a question".

- **Click handler** — when you click the notification body, GNOME Shell fires
  `ActionInvoked(id, "default")` over D-Bus. The extension then runs:
  1. `tmux select-window` + `select-pane` to focus pi's pane within tmux
  2. `xdotool windowactivate <captured-window-id>` to raise the terminal

## Why not node-notifier?

`node-notifier` on Linux shells out to `notify-send`, which on Ubuntu 22.04
ships at version 0.7.9 — too old for `--action` or `--wait`, meaning the click
handler can never fire. We bypass `notify-send` entirely and talk to GNOME's
notification daemon directly via D-Bus using `@particle/dbus-next`.

## Limitations

- X11 only (no Wayland support yet)
- If you close the terminal that originally launched pi and resume in a
  different window, `windowactivate` falls back to picking any visible
  gnome-terminal window
- Only `gnome-terminal` is in the fallback class search; users of alacritty/
  kitty/etc. should still work via the primary `windowactivate <id>` path
