import dbusNs from '@particle/dbus-next';

// CJS interop — @particle/dbus-next is CJS; under jiti default may or may not be set
const dbus: any = (dbusNs as any).default ?? dbusNs;
const { Variant } = dbus;

const BUS_NAME = 'org.freedesktop.Notifications';
const OBJECT_PATH = '/org/freedesktop/Notifications';
const IFACE_NAME = 'org.freedesktop.Notifications';

export interface NotifyAction {
  key: string;    // 'default' for click-the-body, or arbitrary id
  label: string;  // shown on button (if daemon shows buttons)
}

export interface NotifyOptions {
  appName?: string;      // default 'pi'
  appIcon?: string;      // default ''
  summary: string;
  body: string;
  actions?: NotifyAction[];
  hints?: Record<string, any>; // already-wrapped Variants OR plain values we'll auto-wrap
  /** Timeout in ms. -1 = daemon default, 0 = never expire. Default 10000. */
  timeoutMs?: number;
  /** Replace an existing notification by id (0 = new). Default 0. */
  replacesId?: number;
  onAction?: (actionKey: string) => void;
  onClosed?: (reason: number) => void;
}

export class DBusNotifier {
  private bus: any = null;
  private iface: any = null;
  private callbacks = new Map<number, { onAction?: (k: string) => void; onClosed?: (r: number) => void }>();
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;
    this.bus = dbus.sessionBus();
    const obj = await this.bus.getProxyObject(BUS_NAME, OBJECT_PATH);
    this.iface = obj.getInterface(IFACE_NAME);

    this.iface.on('ActionInvoked', (id: number, actionKey: string) => {
      const cb = this.callbacks.get(id);
      cb?.onAction?.(actionKey);
    });

    this.iface.on('NotificationClosed', (id: number, reason: number) => {
      const cb = this.callbacks.get(id);
      cb?.onClosed?.(reason);
      this.callbacks.delete(id);
    });

    this.connected = true;
  }

  /** Returns notification id (uint32) from the daemon. */
  async notify(opts: NotifyOptions): Promise<number> {
    if (!this.connected) throw new Error('DBusNotifier.notify called before connect()');

    // Flatten actions to [key1, label1, key2, label2, ...]
    const flatActions: string[] = [];
    for (const a of opts.actions ?? []) flatActions.push(a.key, a.label);

    // Hints: ensure values are Variants. If caller passed a Variant, leave it.
    const hints: Record<string, any> = {};
    for (const [k, v] of Object.entries(opts.hints ?? {})) {
      if (v && typeof v === 'object' && 'signature' in v && 'value' in v) {
        hints[k] = v; // already a Variant
      } else if (typeof v === 'string') {
        hints[k] = new Variant('s', v);
      } else if (typeof v === 'boolean') {
        hints[k] = new Variant('b', v);
      } else if (typeof v === 'number') {
        hints[k] = new Variant('i', v);
      } else {
        // best-effort string
        hints[k] = new Variant('s', String(v));
      }
    }

    const id: number = await this.iface.Notify(
      opts.appName ?? 'pi',
      opts.replacesId ?? 0,
      opts.appIcon ?? '',
      opts.summary,
      opts.body,
      flatActions,
      hints,
      opts.timeoutMs ?? 10000
    );

    if (opts.onAction || opts.onClosed) {
      this.callbacks.set(id, { onAction: opts.onAction, onClosed: opts.onClosed });
    }
    return id;
  }

  disconnect(): void {
    if (!this.connected) return;
    try { this.bus?.disconnect(); } catch { /* ignore */ }
    this.bus = null;
    this.iface = null;
    this.callbacks.clear();
    this.connected = false;
  }
}
