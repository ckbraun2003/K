/**
 * Preload — runs in the renderer BEFORE the SPA's own scripts, with
 * contextIsolation + sandbox on (no Node in the page). Two jobs:
 *
 *  1. Seed core's bearer token into sessionStorage under the SAME key the web app
 *     reads ('k.harnessToken', see web/src/lib/auth.ts) so the SPA auto-authenticates
 *     with no login screen. The token comes from main over a SYNCHRONOUS IPC call
 *     (so it's set before the first API request), never via argv or the URL.
 *  2. Expose a tiny read-only `window.__K_DESKTOP__` flag so the web can tell it's
 *     running inside the desktop shell.
 *
 * Both are best-effort: if anything throws, the SPA simply falls back to its normal
 * login screen — the app degrades, never crashes.
 */
import { contextBridge, ipcRenderer } from 'electron'

try {
  const cfg = ipcRenderer.sendSync('k:config:sync') as { token?: string } | undefined
  if (cfg && typeof cfg.token === 'string' && cfg.token.length > 0) {
    window.sessionStorage.setItem('k.harnessToken', cfg.token)
  }
} catch {
  /* fall back to the login screen */
}

try {
  contextBridge.exposeInMainWorld('__K_DESKTOP__', { isDesktop: true })
} catch {
  /* exposeInMainWorld can only run once per world — ignore a double-run */
}
