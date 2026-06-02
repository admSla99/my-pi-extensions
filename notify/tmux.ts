import { execFileSync } from 'node:child_process';

const TMUX = '/usr/bin/tmux';
const XDOTOOL = '/usr/bin/xdotool';

/** Target captured at session_start. */
export interface JumpTarget {
  /** tmux pane id like '%1' (always present if we're in tmux) */
  pane: string | null;
  /** tmux session name (for fallback) */
  session: string | null;
  /** X11 window id (decimal string) of the terminal that hosted pi at startup */
  windowId: string | null;
}

/**
 * Capture jump target. Safe to call at session_start — never throws.
 * Returns nulls for fields that couldn't be captured.
 *
 * Key insight: at session_start the terminal hosting the freshly-launched pi
 * IS the X11 active window. We capture `xdotool getactivewindow` once and
 * store the window ID for the session lifetime. This is more reliable than
 * searching by PID (gnome-terminal-server hosts all windows under one PID).
 */
export function captureTarget(): JumpTarget {
  const pane = process.env.TMUX_PANE ?? null;

  let session: string | null = null;
  if (pane) {
    try {
      session = execFileSync(TMUX, ['display', '-p', '-t', pane, '#S'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch { /* ignore */ }
  }

  let windowId: string | null = null;
  try {
    windowId = execFileSync(XDOTOOL, ['getactivewindow'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { /* ignore */ }

  return { pane, session, windowId };
}

/**
 * Jump to target. Best-effort and fully silent — no throws, no logs.
 * Steps:
 *   1. Inside tmux: select-window then select-pane (focuses pi's pane regardless of client)
 *   2. Raise the captured terminal window via xdotool
 *   3. Fallback: activate any visible gnome-terminal window
 */
export function jumpTo(target: JumpTarget): void {
  // 1. tmux focus
  if (target.pane) {
    safeSpawn(TMUX, ['select-window', '-t', target.pane]);
    safeSpawn(TMUX, ['select-pane', '-t', target.pane]);
  }

  // 2. raise specific captured window
  if (target.windowId) {
    const ok = safeSpawn(XDOTOOL, ['windowactivate', target.windowId]);
    if (ok) return;
  }

  // 3. fallback — any visible gnome-terminal window
  safeSpawn('/bin/sh', [
    '-c',
    `${XDOTOOL} search --onlyvisible --class gnome-terminal | tail -1 | xargs -r ${XDOTOOL} windowactivate`,
  ]);
}

function safeSpawn(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
