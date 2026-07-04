/**
 * Build-time helpers for the vite `define` block (imported by web/vite.config.ts).
 * Kept here (pure, no vite/DOM deps) so they are unit-testable without importing
 * the whole vite config. See vite.config.ts for how they are wired.
 */

/** The dev-convenience terminal token — the ONLY terminal token ever baked into a
 *  bundle, and only in a DEV (vite serve) build. */
export const DEV_TERMINAL_TOKEN = 'dev-terminal-token'

/** The dev-convenience harness token — the ONLY harness token ever baked into a
 *  bundle, and only in a DEV (vite serve) build. */
export const DEV_HARNESS_TOKEN = 'dev-token-change-me'

/**
 * Compute the `import.meta.env.VITE_HARNESS_TOKEN` define value. Same guard as
 * terminalTokenDefine: NEVER compile a REAL harness token into any bundle, and
 * NEVER compile ANY token (not even the dev literal) into a PROD build — emit
 * `undefined` so the real token reaches the client only via the runtime login
 * (sessionStorage). Only a DEV server (vite serve) with no real token gets the dev
 * literal, so `pnpm dev` stays zero-friction (the WS auto-auth + the /api dev
 * proxy both work on loopback). A prod `vite build` with no HARNESS_TOKEN set thus
 * bakes NO usable token (previously it baked the dev literal — the same
 * credential-in-prod-bundle hole closed for the terminal token).
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
 * Compute the `import.meta.env.VITE_TERMINAL_TOKEN` define value. Mirrors the
 * harness-token guard, but stricter: NEVER compile a REAL terminal token into any
 * bundle, and NEVER compile ANY token (not even the dev literal) into a PROD
 * build — emit the literal `undefined` so the token must be injected at runtime
 * (like the harness login). Only a DEV server with no real token gets the dev
 * literal, for zero-friction loopback dev. The terminal grants a host shell, so a
 * leaked prod bundle must carry no usable token.
 *
 * Returns a STRING of source to inline via vite `define`: either `'undefined'` or
 * a JSON string literal.
 */
export function terminalTokenDefine(opts: { isDev: boolean; token?: string }): string {
  const { isDev, token } = opts
  const realToken = !!token && token !== DEV_TERMINAL_TOKEN
  if (realToken || !isDev) return 'undefined'
  return JSON.stringify(token ?? DEV_TERMINAL_TOKEN)
}
