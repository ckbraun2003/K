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

/** Resolve the login shell for the current platform. */
export function resolveShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  return process.env.SHELL ?? 'bash'
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
