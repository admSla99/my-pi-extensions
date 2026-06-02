import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DBusNotifier } from './dbus.js';
import { captureTarget, jumpTo, type JumpTarget } from './tmux.js';

export default function (pi: ExtensionAPI) {
  let notifier: DBusNotifier | null = null;
  let target: JumpTarget = { pane: null, session: null, windowId: null };

  pi.on('session_start', async () => {
    target = captureTarget();
    notifier = new DBusNotifier();
    try {
      await notifier.connect();
    } catch (err) {
      // D-Bus unavailable (e.g. headless ssh) — extension becomes a no-op silently.
      console.error('[pi-tmux-notify] D-Bus connect failed:', (err as Error).message);
      notifier = null;
    }
  });

  /** Build summary line; include session name if set. */
  function summaryLine(fallback: string): string {
    const name = (pi as any).getSessionName?.();
    return name ? `pi — ${name}` : fallback;
  }

  /** Fire-and-forget notification. */
  function dispatch(summary: string, body: string): void {
    if (!notifier) return;
    notifier
      .notify({
        appName: 'pi',
        summary,
        body,
        timeoutMs: 10000,
        actions: target.pane || target.windowId ? [{ key: 'default', label: 'Open' }] : [],
        onAction: (key) => {
          if (key === 'default') jumpTo(target);
        },
      })
      .catch((err) => {
        console.error('[pi-tmux-notify] notify failed:', (err as Error).message);
      });
  }

  pi.on('agent_end', () => {
    dispatch(summaryLine('pi'), 'Agent complete — click to jump');
  });

  pi.on('tool_execution_start' as any, (event: any) => {
    // event.toolName is the tool the agent is about to invoke.
    const toolName: string | undefined = event?.toolName ?? event?.name;
    if (toolName === 'ask_user') {
      dispatch(summaryLine('pi — question'), 'Agent is asking a question');
    }
  });

  pi.on('session_shutdown', async () => {
    notifier?.disconnect();
    notifier = null;
  });
}
