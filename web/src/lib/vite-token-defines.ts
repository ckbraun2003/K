/**
 * Build-time helpers for the vite `define` block (imported by web/vite.config.ts).
 * Kept here (pure, no vite/DOM deps) so they are unit-testable without importing
 * the whole vite config. See vite.config.ts for how they are wired.
 */

/** The dev-convenience harness token — the ONLY harness token ever baked into a
 *  bundle, and only in a DEV (vite serve) build. */
export const DEV_HARNESS_TOKEN = 'dev-token-change-me'

/**
 * Compute the `import.meta.env.VITE_HARNESS_TOKEN` define value. NEVER compile a
 * REAL harness token into any bundle, and NEVER compile ANY token (not even the
 * dev literal) into a PROD build — emit `undefined` so the real token reaches
 * the client only via the runtime login (sessionStorage). Only a DEV server
 * (vite serve) with no real token gets the dev literal, so `pnpm dev` stays
 * zero-friction (the WS auto-auth + the /api dev proxy both work on loopback).
 * A prod `vite build` with no HARNESS_TOKEN set thus bakes NO usable token.
 *
 * Returns a STRING of source to inline via vite `define`.
 */
export function harnessTokenDefine(opts: { isDev: boolean; token?: string }): string {
  const { isDev, token } = opts
  const realToken = !!token && token !== DEV_HARNESS_TOKEN
  if (realToken || !isDev) return 'undefined'
  return JSON.stringify(token ?? DEV_HARNESS_TOKEN)
}

/**
 * F-086: is the dev-server `/api` auto-auth ON? Under `pnpm dev` the Vite proxy injects
 * a Bearer into every proxied `/api` request so loopback dev needs no login. Setting
 * `VITE_DEV_AUTOAUTH=0` suppresses that injection so a dev can exercise the REAL 401
 * login gate. Default (unset / any value ≠ '0') = today's zero-friction auto-auth, so a
 * normal `pnpm dev` is unchanged.
 *
 * SCOPE (documented, not changed here): this flag gates only the REST `/api` proxy Bearer
 * (below). The authenticated `/ws` gateway is separately auto-authed via the baked
 * `VITE_HARNESS_TOKEN` define (owned by the harness-token define wiring), which this flag
 * does NOT touch — so with `VITE_DEV_AUTOAUTH=0` the REST login gate becomes reachable
 * while the WS gateway keeps its dev auto-auth. Pure so the flag logic is unit-testable
 * even though the proxy hook itself is not.
 */
export function devAutoAuthEnabled(env: { VITE_DEV_AUTOAUTH?: string }): boolean {
  return env.VITE_DEV_AUTOAUTH !== '0'
}

/**
 * F-086: the `Authorization` header the `/api` dev proxy should inject, or `undefined`
 * to inject NOTHING (so the real 401 login gate is reachable under `pnpm dev`). Returns
 * undefined when auto-auth is disabled; otherwise `Bearer <token>` using the real
 * `HARNESS_TOKEN` when set, else the dev literal. Pure + exported so the flag/header
 * logic is unit-testable (the proxy `configure` hook itself is not).
 */
export function devProxyAuthHeader(opts: { autoAuth: boolean; token?: string }): string | undefined {
  if (!opts.autoAuth) return undefined
  return `Bearer ${opts.token ?? DEV_HARNESS_TOKEN}`
}
