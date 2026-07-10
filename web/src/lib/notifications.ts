/**
 * E-19 — browser Notification API leg (greenfield: no precedent in web/src).
 * Permission is requested ONLY from a user gesture (the Settings browser-channel
 * toggle); the raiser stays silent while the app is visible — the in-app center
 * and toasts own the foreground.
 */
import type { WsMessage } from '@k/shared'

/** True when the SPA is running inside the K desktop (Electron) shell — the preload
 *  sets `window.__K_DESKTOP__`. In that case the shell's main process is the single
 *  native-notification authority (it consumes the same `type:'notification'` events
 *  from core's main process, which stays alive even when the window is tray-hidden),
 *  so the renderer leg stands down to avoid double toasts. */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as { __K_DESKTOP__?: { isDesktop?: boolean } }).__K_DESKTOP__?.isDesktop
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!browserNotificationsSupported()) return false
  if (window.Notification.permission === 'granted') return true
  if (window.Notification.permission === 'denied') return false
  try { return (await window.Notification.requestPermission()) === 'granted' } catch { return false }
}

export function raiseBrowserNotification(msg: WsMessage): void {
  if (msg.type !== 'notification' || !msg.browser) return
  // In the desktop shell the main process raises native toasts (reliable even when
  // the window is tray-hidden) — stand down so the operator never gets two.
  if (isDesktopShell()) return
  if (!browserNotificationsSupported() || window.Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible') return
  try {
    new window.Notification(msg.notification.title, {
      body: msg.notification.body ?? undefined,
      tag: msg.notification.id, // dedupe key — a re-broadcast replaces, never stacks
    })
  } catch { /* platform quirks (e.g. no SW on some builds) must never break the WS handler */ }
}
