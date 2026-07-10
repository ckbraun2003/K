/**
 * Pure notification + tray helpers (no Electron import — unit-tested in
 * test/notifications.test.ts). main.ts wires these into Electron's Notification,
 * Tray, and a `ws` subscriber to core's /ws gateway.
 *
 * The shell subscribes to core's event wire as just another WS client (no core
 * change) and raises a native OS notification for the run-lifecycle transitions an
 * operator cares about while the window is hidden in the tray.
 */

/** The subset of core's E-19 `type:'notification'` envelope the shell reads. A
 *  minimal structural type keeps this decoupled from @k/shared (and its build). */
export interface NotificationEnvelopeLike {
  type?: string
  /** The user's per-event "native/browser channel" preference, already resolved by
   *  core's rules engine (E-19). We only raise an OS toast when this is true. */
  browser?: boolean
  notification?: { title?: string; body?: string | null; runId?: string | null }
}

export interface DesktopNotification {
  title: string
  body: string
  /** The run this notification is about (carried through for a future click-to-run;
   *  the current click just focuses the window). */
  runId?: string
}

/**
 * Decide whether a core WS message warrants a NATIVE OS notification.
 *
 * The desktop shell is the SINGLE native-notification authority — the renderer's
 * browser-notification leg stands down in desktop mode (web/src/lib/notifications
 * isDesktopShell), because the main process stays alive even when the window is
 * hidden in the tray. So it consumes core's E-19 `type:'notification'` envelopes,
 * which have ALREADY applied the operator's per-event rules AND deduped by status
 * transition (core/src/notify.ts), and raises a toast only when the resolved
 * `browser` channel is on. Any other message (run_update, event, in-app-only
 * notification, garbage) → null.
 */
export function notificationFromEnvelope(msg: unknown): DesktopNotification | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as NotificationEnvelopeLike
  if (m.type !== 'notification' || m.browser !== true || !m.notification) return null
  const title = m.notification.title
  if (typeof title !== 'string' || title.length === 0) return null
  return {
    title,
    body: typeof m.notification.body === 'string' ? m.notification.body : '',
    runId: typeof m.notification.runId === 'string' ? m.notification.runId : undefined,
  }
}

export interface TrayMenuItem {
  label: string
  action: 'toggle' | 'quit'
}

/** Build the tray context-menu template (label + a semantic action). main maps the
 *  actions onto real Electron click handlers — kept pure so the labels/structure are
 *  testable without a display. */
export function buildTrayMenu(windowVisible: boolean): TrayMenuItem[] {
  return [
    { label: windowVisible ? 'Hide K' : 'Show K', action: 'toggle' },
    { label: 'Quit K', action: 'quit' },
  ]
}

/** The core /ws gateway URL for the tray's own subscriber (token in the query — a WS
 *  upgrade can't carry an auth header). */
export function coreWsUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`
}
