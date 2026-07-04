/**
 * Web terminal — testable core.
 *
 * This module is deliberately node-pty-free: the real pty is INJECTED by the ws
 * handler (index.ts) via a dynamic `import('node-pty')`, so core boot never
 * depends on the native binding and tests can drive a fake spawn. Two pieces:
 *   - `terminalGate`   — pure enable/auth decision (no I/O).
 *   - `createTerminalSession` — bridges a pty to a JSON frame protocol.
 */

import { wsTokenOk } from './auth.js'

/** Minimal slice of node-pty's IPty that the session needs (keeps node-pty out of here). */
export interface PtyLike {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type SpawnPty = (shell: string, cols: number, rows: number) => PtyLike

export interface TerminalIo {
  send: (frame: object) => void
  spawn?: SpawnPty
}

export type GateResult = { ok: true } | { ok: false; code: 'disabled' | 'unauthorized' }

/**
 * Pure gate for the terminal WS. Shell access is sensitive, so this is the one
 * place the enable-flag and token are checked — before any pty is touched.
 *   - feature flag off            → disabled
 *   - missing/empty/wrong token   → unauthorized
 *   - enabled + matching token    → ok
 */
export function terminalGate(opts: {
  enabled: boolean
  token: string | undefined
  expectedToken: string
}): GateResult {
  if (!opts.enabled) return { ok: false, code: 'disabled' }
  // Constant-time compare: the terminal token grants a host shell, so avoid a
  // timing oracle. wsTokenOk also rejects unset/empty tokens.
  if (!wsTokenOk(opts.token, opts.expectedToken)) {
    return { ok: false, code: 'unauthorized' }
  }
  return { ok: true }
}

/**
 * F-088: recognise the ONE benign noise line node-pty's Windows ConPTY teardown emits.
 *
 * On pty teardown node-pty `child_process.fork()`s a `conpty_console_list_agent` helper
 * to enumerate the console's process ids. In a kill-vs-AttachConsole race the helper's
 * native call fails and the child throws `Error: AttachConsole failed`, printing an
 * uncaught stack to core's stderr. It is harmless — node-pty's own 5s setTimeout fallback
 * resolves with the shell pid — but the stack reads as alarming in the log.
 *
 * This predicate matches ONLY that helper's output: the exact `AttachConsole failed`
 * Win32 error string, or a stack frame naming the `conpty_console_list_agent` helper file
 * (a single write can split the message from its stack). Both tokens are node-pty
 * internals that NO legitimate K error carries, so any real error returns false and
 * passes through untouched. Pure + exported so the exact match is unit-locked.
 */
export function isBenignConptyNoise(text: string): boolean {
  return text.includes('AttachConsole failed') || text.includes('conpty_console_list_agent')
}

/**
 * F-088: wrap a `process.stderr.write`-shaped function so it DROPS only the benign
 * node-pty ConPTY noise (see isBenignConptyNoise) and forwards everything else to
 * `original` with identical args + return value — we never broadly swallow stderr. Pure
 * (no global state) so the filtering behavior is unit-testable without touching the real
 * stderr. A dropped write still invokes any supplied completion callback so a caller
 * awaiting the write never hangs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeFilteredStderrWrite(original: (chunk: any, ...rest: any[]) => boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (chunk: any, ...rest: any[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    if (text && isBenignConptyNoise(text)) {
      const cb = rest.find((a) => typeof a === 'function') as ((err?: Error | null) => void) | undefined
      cb?.()
      return true // pretend the write succeeded; the noise is discarded
    }
    return original(chunk, ...rest)
  }
}

let conptyStderrFilterInstalled = false

/**
 * F-088: idempotently install the narrow ConPTY-noise filter on `process.stderr.write`.
 * Called when the web terminal spawns a pty (the only path that can produce the noise).
 *
 * REACH LIMITATION (documented honestly): node-pty forks the console-list helper with
 * INHERITED stdio, so the child's uncaught stack is written to the process's fd 2
 * directly and can bypass this JS-level wrapper (verified: a forked child's stderr does
 * not pass through the parent's `process.stderr.write`). This filter reliably suppresses
 * any occurrence routed through `process.stderr`; a pure-JS wrapper cannot intercept a
 * raw inherited-fd write from another process. We deliberately do NOT hijack fd 2 for a
 * benign, self-limiting cosmetic race — the predicate is the unit-locked contract, and a
 * complete suppression would require an fd-level shim (candidate for a later wave) or a
 * node-pty upstream fix.
 */
export function installConptyStderrFilter(): void {
  if (conptyStderrFilterInstalled) return
  conptyStderrFilterInstalled = true
  const original = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = makeFilteredStderrWrite(original as any)
}

/** Resolve the login shell for the current platform. */
export function resolveShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  return process.env.SHELL ?? 'bash'
}

/**
 * Env-var names the browser terminal MUST NOT inherit. The core process is
 * launched with its own credentials in its environment (ANTHROPIC_API_KEY,
 * HARNESS_TOKEN, TERMINAL_TOKEN, CLAUDE_*, cloud keys, npm auth, …). A naive
 * `env: process.env` handed to the pty would let anyone with terminal access
 * `echo $ANTHROPIC_API_KEY` (or any other secret) straight out of the shell.
 *
 * We DENYLIST by name pattern (case-insensitive) rather than allowlist so the
 * shell keeps a fully functional environment — PATH, HOME, SystemRoot, windir,
 * PATHEXT, TEMP/TMP, locale, TERM, ComSpec, etc. all survive — while every
 * credential-shaped variable is stripped. Over-stripping a benign config var
 * (e.g. AWS_REGION) is SAFE (the shell just loses a default); UNDER-stripping a
 * secret is the real risk, so the patterns are deliberately broad. Env names are
 * case-insensitive on Windows and case-sensitive on POSIX — matching
 * case-insensitively is correct (and strictly safer) on both.
 */
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  // Generic credential keywords, matched anywhere in the name.
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /API_?KEY/i,
  /ACCESS_?KEY/i,
  /PRIVATE_?KEY/i,
  /SESSION_?KEY/i,
  /_KEY$/i,
  // Connection strings / DSNs / shorthand passwords that embed `user:pass@host`
  // or a bare secret (DATABASE_URL, REDIS_URL, MONGODB_URI, *_DSN, DB_PASS, DB_PWD).
  // Tradeoff: `_URL`/`_URI` is a broad catch-all that also drops a benign endpoint
  // URL from the shell — accepted, because this is defense-in-depth (a token-holding
  // attacker already has host access) and losing a URL var degrades the shell far
  // less than leaking an embedded credential. `_PWD$` (not bare `PWD`) preserves the
  // POSIX current-directory var.
  /CONNECTION/i,
  /_URL$/i,
  /_URI$/i,
  /_DSN$/i,
  /_PASS$/i,
  /_PWD$/i,
  // Vendor / tooling prefixes whose vars are credentials or credential-adjacent.
  /^ANTHROPIC_/i,
  /^CLAUDE_/i,
  /^OPENAI_/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^GITLAB_/i,
  /^NPM_/i,
  /^PNPM_/i,
  /^YARN_/i,
  /^NODE_AUTH/i,
  /^HF_/i,
  /^HUGGING/i,
  /^HARNESS_/i,
  /^TERMINAL_/i,
]

/** True when `name` looks like a credential-bearing env var (see the denylist). Pure. */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(name))
}

/**
 * Return a COPY of `env` with every credential-shaped variable removed and every
 * `undefined` value dropped. Pure — used to build the pty's environment so the
 * browser shell never inherits the core's secrets. See SENSITIVE_ENV_PATTERNS.
 */
export function scrubSensitiveEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (isSensitiveEnvName(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Bridge a pty to the client frame protocol. The caller supplies `io.send` (one
 * JSON frame per call) and `io.spawn` (the injected real or fake pty factory).
 *
 * Server → client frames: { type:'output', data } | { type:'exit', exitCode }.
 * Client → server frames : { type:'input', data } | { type:'resize', cols, rows }.
 * Unknown/malformed client frames are ignored (never throw).
 */
export function createTerminalSession(io: TerminalIo): {
  onClientMessage(raw: string): void
  dispose(): void
} {
  const spawn = io.spawn
  if (spawn == null) throw new Error('createTerminalSession requires io.spawn')

  const pty = spawn(resolveShell(), 80, 24)
  let disposed = false

  pty.onData((d) => io.send({ type: 'output', data: d }))
  pty.onExit((e) => {
    io.send({ type: 'exit', exitCode: e.exitCode })
    dispose()
  })

  function onClientMessage(raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return // malformed JSON — ignore
    }
    if (typeof msg !== 'object' || msg == null) return
    const frame = msg as Record<string, unknown>
    if (frame.type === 'input' && typeof frame.data === 'string') {
      pty.write(frame.data)
    } else if (
      frame.type === 'resize' &&
      typeof frame.cols === 'number' &&
      typeof frame.rows === 'number'
    ) {
      pty.resize(frame.cols, frame.rows)
    }
    // unknown frame types are ignored
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    try {
      pty.kill()
    } catch {
      // Windows kill() can throw if the process already exited — safe to ignore.
    }
  }

  return { onClientMessage, dispose }
}
