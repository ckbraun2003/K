/**
 * Web terminal — pure protocol helpers (unit-tested in web/test/terminal.test.ts).
 *
 * All branchy logic lives here so TerminalPage stays a thin xterm/WS shell. The
 * server frame parser is deliberately tolerant: a bad frame yields null rather
 * than throwing, so a hostile/garbled socket can't crash the UI.
 */

/**
 * Build the terminal WS URL — points straight at core (not the Vite proxy).
 *
 * `port` is required (no default) so every caller must supply the core port and
 * a port-shifted stack physically can't fall back to a hardcoded 3001 — the e2e
 * harness and multi-device setups run core off-default. Caller computes it the
 * same way the main gateway does (`import.meta.env.VITE_CORE_PORT ?? '3001'`,
 * see lib/ws.ts).
 */
export function terminalWsUrl(hostname: string, token: string, port: string): string {
  return `ws://${hostname}:${port}/ws/terminal?token=${encodeURIComponent(token)}`
}

/** Client → server: keystrokes. */
export function encodeInput(data: string): string {
  return JSON.stringify({ type: 'input', data })
}

/** Client → server: viewport resize. */
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows })
}

export type ServerFrame =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; code: string }

/** Server → client: tolerant parse. Returns null for anything malformed/unknown. */
export function parseServerFrame(raw: string): ServerFrame | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg == null) return null
  const f = msg as Record<string, unknown>
  if (f.type === 'output' && typeof f.data === 'string') return { type: 'output', data: f.data }
  if (f.type === 'exit' && typeof f.exitCode === 'number') return { type: 'exit', exitCode: f.exitCode }
  if (f.type === 'error' && typeof f.code === 'string') return { type: 'error', code: f.code }
  return null
}

/** Human-readable reason for an error frame's code. */
export function errorReason(code: string): string {
  switch (code) {
    case 'disabled':
      return 'Terminal disabled — set ENABLE_TERMINAL=true to enable it.'
    case 'unauthorized':
      return 'Unauthorized — the terminal token did not match.'
    case 'unavailable':
      return 'pty unavailable on this platform.'
    default:
      return `Terminal error: ${code}`
  }
}
