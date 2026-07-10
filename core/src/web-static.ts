/**
 * Same-origin web serving — pure helpers (unit-tested in web-static.test.ts).
 *
 * When `K_WEB_DIST` points at a built SPA (the packaged desktop app; or an opt-in
 * `pnpm start` with the env set), core serves the React bundle itself, so the whole
 * app lives on ONE origin: the browser loads the bundle from core, the client's
 * relative `/api` and same-host `/ws` just work, and there is no CORS or cross-port
 * wiring. Otherwise this is inert — Vite serves the SPA in dev and core only
 * answers `/api` + `/ws`.
 *
 * SECURITY MODEL: the SPA bundle is PUBLIC (it bakes no token — a prod `vite build`
 * emits none), exactly as when Vite serves it. The token gates the DATA plane, not
 * the static files: every REST route is under `/api/*` (bearer-checked) and `/ws*`
 * (query-token-checked). So static asset requests are auth-exempt; API/WS are not.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve the built web SPA directory to serve, or null if static serving is off.
 *
 * Triggered ONLY by an explicit `K_WEB_DIST`. The packaged desktop app (W5) points
 * it at the bundled `web/dist`; outside Electron, same-origin serving is opt-in —
 * set `K_WEB_DIST=<abs path to web/dist>` before `node dist/index.js`. There is NO
 * filesystem-default auto-detection by design: it keeps behavior deterministic
 * across environments so core tests never flip into static-serving mode just
 * because a local `web/dist` build happens to sit on disk.
 *
 * The dir only counts when it actually holds an `index.html`, so a stale/empty
 * path degrades to "no static serving" (core still answers `/api` + `/ws`) rather
 * than serving a broken shell.
 */
export function resolveWebDist(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.K_WEB_DIST?.trim()
  if (!explicit) return null
  return fs.existsSync(path.join(explicit, 'index.html')) ? path.resolve(explicit) : null
}

/**
 * Should this request bypass the bearer-auth hook because it targets a PUBLIC SPA
 * asset (only meaningful when static serving is active)?
 *
 * True only for read methods (GET/HEAD) whose pathname is NOT under `/api` and NOT
 * a `/ws` upgrade. Everything sensitive is `/api/*` or `/ws*` and stays gated; the
 * SPA shell, its hashed assets, and hash-router deep links are public — the same
 * posture as Vite serving the bundle. Pathname is parsed the same query/dot-segment
 * -immune way as `isAuthExempt` (auth.ts).
 */
export function isPublicAssetPath(method: string, url: string): boolean {
  const m = method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  let pathname: string
  try {
    pathname = new URL(url, 'http://localhost').pathname
  } catch {
    return false
  }
  // Lowercase before the prefix check (like the method casing above). Fastify's
  // router is case-sensitive, so a mixed-case `/API/x` never reaches a real handler
  // anyway — this just keeps the "is this on the sensitive side of the line?" answer
  // consistent (a look-alike path is treated as gated, not served the public shell).
  const p = pathname.toLowerCase()
  if (p === '/api' || p.startsWith('/api/')) return false
  if (p === '/ws' || p.startsWith('/ws/')) return false
  return true
}
