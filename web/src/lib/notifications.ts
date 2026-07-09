/**
 * E-19 — browser Notification API leg (greenfield: no precedent in web/src).
 * Permission is requested ONLY from a user gesture (the Settings browser-channel
 * toggle); the raiser stays silent while the app is visible — the in-app center
 * and toasts own the foreground.
 */
import type { WsMessage } from '@k/shared'

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
  if (!browserNotificationsSupported() || window.Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible') return
  try {
    new window.Notification(msg.notification.title, {
      body: msg.notification.body ?? undefined,
      tag: msg.notification.id, // dedupe key — a re-broadcast replaces, never stacks
    })
  } catch { /* platform quirks (e.g. no SW on some builds) must never break the WS handler */ }
}
