/**
 * Where the browser should dial core's WebSocket endpoints (/ws).
 * Pure + unit-tested (web/test/core-origin.test.ts).
 *
 * PROD (packaged desktop app, or any `pnpm build` served by core): the SPA is
 * served SAME-ORIGIN by core, so /ws lives on the page's own host:port — dial
 * `window.location.host` and mirror its scheme. No build-frozen port, so the
 * desktop app's dynamic core port works with zero injection.
 *
 * DEV (`pnpm dev`): Vite serves the SPA on :5173 and the /ws upgrade is NOT
 * proxied, so dial core directly on VITE_CORE_PORT (the e2e swarm overrides it
 * per isolated stack).
 */

export interface LocationLike {
  protocol: string
  hostname: string
  host: string
}

/**
 * Build the `ws[s]://host[:port]` base (no path) for core's WS endpoints.
 * In dev, host = `${hostname}:${corePort}`; in prod, host = the page's own host.
 * Scheme mirrors the page: `wss` on an https page, `ws` otherwise (a mixed-content
 * ws:// on an https page is blocked).
 */
export function coreWsBase(
  loc: LocationLike,
  opts: { isDev: boolean; corePort: string },
): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  const host = opts.isDev ? `${loc.hostname}:${opts.corePort}` : loc.host
  return `${scheme}://${host}`
}
