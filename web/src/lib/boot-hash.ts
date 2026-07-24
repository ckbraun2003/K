/**
 * Boot-time hash normalization (UI Adjustments Task C1). After a send on Home,
 * MessageDock navigates to `#/messages/<id>` so the transcript stays visible on
 * that URL — but a reload landing on that same URL would let MessagesPage
 * re-select the thread from the deep-linked id, resuming it. That defeats the
 * "boot always opens a new chat draft" rule now enforced by thread-select.ts
 * (which no longer seeds its selection from localStorage): the dock would show
 * an empty composer while Messages, driven by the URL, reopened the old thread.
 *
 * `normalizeBootHash` strips a `#/messages/<id>` deep link down to the bare
 * `#/messages` hash — same surface (the Messages list + empty hero), no
 * resumed selection. It is pure and run exactly once, before React mounts
 * (see main.tsx); in-app navigation to `#/messages/<id>` (e.g. clicking a row)
 * happens after boot and is untouched.
 */
export function normalizeBootHash(hash: string): string {
  return /^#\/messages\/.+/.test(hash) ? '#/messages' : hash
}
