/**
 * Client auth — supplies the harness token to REST + WS.
 *
 * Two modes, zero login in dev:
 *  - DEV: the Vite proxy injects `Authorization` on /api for us, and a dev
 *    harness token is exposed via `import.meta.env.VITE_HARNESS_TOKEN` (set in
 *    vite.config.ts) so the WS can authenticate. No real secret is baked in —
 *    only the dev convenience token, which is harmless on loopback.
 *  - REMOTE: when a REST call 401s, the app prompts for the harness token and
 *    stores it in sessionStorage. From then on it is attached as a Bearer header
 *    on every `api` fetch and as `?token=` on the WS. The real production token
 *    therefore lives only in sessionStorage at runtime — never in the bundle.
 */

const STORAGE_KEY = 'k.harnessToken'

// Dev convenience token (loopback only). Mirrors the Vite proxy's HARNESS_TOKEN
// default so `pnpm dev` works with no login. Never the real remote token.
const DEV_TOKEN: string | undefined = import.meta.env.VITE_HARNESS_TOKEN

/** Subscribers notified when the token changes (login/logout) so the WS reconnects. */
const listeners = new Set<() => void>()

export function onTokenChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The token the operator entered at the login prompt (remote use), if any. */
export function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    /* private mode / storage disabled — token lives for this call only */
  }
  for (const fn of listeners) {
    try { fn() } catch { /* listeners must not break each other */ }
  }
}

export function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  for (const fn of listeners) {
    try { fn() } catch { /* ignore */ }
  }
}

/**
 * The token to send to core. A session token (operator login) always wins; the
 * dev token is the fallback so loopback dev needs no login. The dev fallback is
 * gated on `import.meta.env.DEV` so even an accidentally-baked value is inert in
 * a production build — sessionStorage is the only token source there. Returns
 * null when neither applies (remote, not yet logged in) → triggers the login screen.
 */
export function effectiveToken(): string | null {
  return getSessionToken() ?? (import.meta.env.DEV ? DEV_TOKEN ?? null : null)
}

/** Authorization header to attach to `api` fetches, or undefined if no token. */
export function authHeader(): Record<string, string> {
  const t = effectiveToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/** True once the operator has explicitly logged in (remote). */
export function hasSessionToken(): boolean {
  return getSessionToken() !== null
}
