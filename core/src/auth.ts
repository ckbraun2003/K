import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** Pure auth-exemption predicate — pathname match, immune to query/dot-segment tricks. */
// '/ws' and '/ws/terminal' are exempt from the header hook because a browser
// WebSocket cannot send an Authorization header. Both validate a `token` query
// param inside their handlers instead: '/ws' against the harness token (see
// wsTokenOk / index.ts), '/ws/terminal' against the scoped TERMINAL_TOKEN.
const PUBLIC_PATHS = new Set(['/ws', '/ws/terminal', '/health'])

export function isAuthExempt(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://localhost')
    // Fail closed on a network-path reference: `//ws` (and its `/\ws` variant, which
    // the http-scheme parser folds to `//ws`) parse with the first segment as the
    // AUTHORITY, so `.pathname` would not match a real exempt route. A genuine path
    // keeps the base host — any other host means an authority-form trick, so gate it.
    if (parsed.host !== 'localhost') return false
    return PUBLIC_PATHS.has(parsed.pathname)
  } catch {
    return false
  }
}

// ── Token resolution + persistence ───────────────────────────────────────────

/** The legacy insecure default that must never silently guard a remote host. */
export const LEGACY_WEAK_TOKEN = 'dev-token-change-me'

/** The dev default for the scoped terminal token — weak, loopback-only. */
export const LEGACY_WEAK_TERMINAL_TOKEN = 'dev-terminal-token'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirror db.ts's DATA_DIR convention so the token sits beside k.db.
const DATA_DIR = process.env.K_DATA_DIR ?? path.join(__dirname, '../../data')
const TOKEN_FILE = path.join(DATA_DIR, 'auth-token')

export interface ResolvedToken {
  token: string
  /** 'env' (HARNESS_TOKEN), 'file' (persisted), or 'generated' (first run). */
  source: 'env' | 'file' | 'generated'
  /** Absolute path to the persisted token file (for operator messaging). */
  file: string
  /** True only when this boot generated and persisted a fresh token. */
  firstRun: boolean
}

/** Generate a cryptographically strong, URL-safe token. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Resolve the harness bearer token on boot, in priority order:
 *   1. HARNESS_TOKEN env (if set, non-empty) — operator override.
 *   2. A persisted token under the data dir (survives restarts).
 *   3. A freshly generated strong token, persisted to disk (FIRST RUN).
 *
 * The file read/write is best-effort: an unwritable data dir degrades to an
 * in-memory generated token (logged), never a crash. On POSIX the file is
 * created 0600; on Windows the mode is advisory (NTFS ACLs govern access).
 *
 * STARTUP ONLY: this does synchronous fs I/O — call it once at boot, never from
 * a request handler.
 */
export function resolveHarnessToken(opts?: {
  env?: string | undefined
  file?: string
}): ResolvedToken {
  const envToken = (opts?.env ?? process.env.HARNESS_TOKEN ?? '').trim()
  const file = opts?.file ?? TOKEN_FILE
  if (envToken) return { token: envToken, source: 'env', file, firstRun: false }

  // (b) persisted token. Read-then-catch (no existsSync) avoids a TOCTOU and
  // naturally falls through to generation on a missing/empty/unreadable file.
  try {
    const persisted = fs.readFileSync(file, 'utf8').trim()
    if (persisted) return { token: persisted, source: 'file', file, firstRun: false }
  } catch {
    /* missing or unreadable file → fall through to generation */
  }

  // (c) generate + persist (first run)
  const token = generateToken()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, token + '\n', { mode: 0o600 })
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* chmod is a no-op / may throw on some Windows FS — perms are best-effort */
    }
  } catch {
    /* unwritable data dir → token stays in memory for this process only */
  }
  return { token, source: 'generated', file, firstRun: true }
}

/**
 * Report the harness token's ORIGIN without ever exposing the token value — for
 * the Settings status endpoint. A non-empty HARNESS_TOKEN env override is 'env';
 * everything else (persisted file or first-run generation) collapses to
 * 'generated' (i.e. "the harness owns this credential"). Pure: reads only the
 * env var, returns no secret.
 */
export function harnessTokenSource(env = process.env.HARNESS_TOKEN): 'env' | 'generated' {
  return (env ?? '').trim() ? 'env' : 'generated'
}

// ── Safety gate ──────────────────────────────────────────────────────────────

/** Loopback hosts that are safe to serve a weak/dev token on. */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1', // IPv4-mapped loopback
])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

/** A token is "weak" if it is empty or the legacy hard-coded literal. */
export function isWeakToken(token: string): boolean {
  const t = token.trim()
  return t === '' || t === LEGACY_WEAK_TOKEN
}

/**
 * A terminal token is "weak" if it is empty or the dev default literal. The
 * terminal grants a host shell, so this gates a non-loopback boot the same way
 * isWeakToken gates the harness token.
 */
export function isWeakTerminalToken(token: string): boolean {
  const t = token.trim()
  return t === '' || t === LEGACY_WEAK_TERMINAL_TOKEN
}

/**
 * Refuse to bind a non-loopback host with a weak/empty token. Returns an
 * actionable error message when the boot is unsafe, or null when it is safe.
 * Pure predicate — callers decide whether to throw (index.ts does).
 */
export function unsafeBootReason(host: string, token: string): string | null {
  if (isLoopbackHost(host)) return null
  if (isWeakToken(token)) {
    return (
      `Refusing to start: HOST=${host} is non-loopback but the harness token is ` +
      `weak or unset. Set a strong HARNESS_TOKEN (e.g. \`openssl rand -base64 32\`), ` +
      `or remove the HARNESS_TOKEN override so a strong one is generated and persisted. ` +
      `Only expose a non-loopback HOST behind Tailscale or an authenticating HTTPS proxy.`
    )
  }
  return null
}

/**
 * Refuse to expose the web terminal (a host shell) on a non-loopback HOST unless
 * it is BOTH guarded by a strong TERMINAL_TOKEN AND explicitly opted in via
 * `TERMINAL_ALLOW_REMOTE=true`. Two independent guards:
 *   1. a weak/empty/default TERMINAL_TOKEN is always refused on a non-loopback host;
 *   2. even a STRONG token is refused on a non-loopback host without the explicit
 *      opt-in, so an accidental LAN bind can never expose the shell silently.
 * Returns an actionable message when unsafe, or null when safe (terminal disabled,
 * loopback host, or strong token + opt-in). Pure predicate — index.ts decides
 * whether to throw.
 */
export function unsafeTerminalBootReason(
  host: string,
  enabled: boolean,
  terminalToken: string,
  allowRemote = false,
): string | null {
  if (!enabled) return null
  if (isLoopbackHost(host)) return null
  if (isWeakTerminalToken(terminalToken)) {
    return (
      `Refusing to start: HOST=${host} is non-loopback and ENABLE_TERMINAL=true, ` +
      `but TERMINAL_TOKEN is weak or unset. The web terminal grants a host shell. ` +
      `Set a strong TERMINAL_TOKEN (e.g. \`openssl rand -base64 32\`), or unset ` +
      `ENABLE_TERMINAL to disable the terminal. Only expose a non-loopback HOST ` +
      `behind Tailscale or an authenticating HTTPS proxy.`
    )
  }
  if (!allowRemote) {
    return (
      `Refusing to start: HOST=${host} is non-loopback and ENABLE_TERMINAL=true. ` +
      `The web terminal grants a host shell, so exposing it beyond loopback needs an ` +
      `EXPLICIT opt-in even with a strong TERMINAL_TOKEN. Set TERMINAL_ALLOW_REMOTE=true ` +
      `to confirm, unset ENABLE_TERMINAL to disable the terminal, or bind a loopback HOST. ` +
      `Only expose a non-loopback HOST behind Tailscale or an authenticating HTTPS proxy.`
    )
  }
  return null
}

// ── Constant-time token comparison ───────────────────────────────────────────

/**
 * Length-guarded constant-time string compare. Returns false (without throwing)
 * on length mismatch, so callers can't leak length via a timingSafeEqual throw.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // Accepted tradeoff: an early length-mismatch return leaks length, but the
  // token is a fixed-length base64url(32) value, so its length is not secret.
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Validate a `?token=` query value (from a WS upgrade) against the harness token. */
export function wsTokenOk(queryToken: string | undefined, expected: string): boolean {
  if (typeof queryToken !== 'string' || queryToken.length === 0) return false
  return tokensEqual(queryToken, expected)
}
