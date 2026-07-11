/**
 * Web terminal — pure protocol helpers (unit-tested in web/test/terminal.test.ts).
 *
 * All branchy logic lives here so TerminalPage stays a thin xterm/WS shell. The
 * server frame parser is deliberately tolerant: a bad frame yields null rather
 * than throwing, so a hostile/garbled socket can't crash the UI.
 */

/**
 * Build the terminal WS URL from a `ws[s]://host` base + token.
 *
 * The caller computes the base via `coreWsBase(window.location, …)` (lib/core-origin),
 * exactly like the main /ws gateway: same-origin in prod (the packaged app's dynamic
 * core port just works, scheme mirrors the page), core's VITE_CORE_PORT in dev. Taking
 * the base (not a bare hostname+port) means the terminal socket can never fall back to
 * a hardcoded `ws://…:3001` and correctly uses `wss://` on an https page.
 */
export function terminalWsUrl(wsBase: string, token: string): string {
  return `${wsBase}/ws/terminal?token=${encodeURIComponent(token)}`
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

/** Human-readable reason for an error frame's code — user-facing, no operator
 *  env-var jargon (the disabled copy tells the operator it's off, not how to set
 *  a server flag). Shown once, in the pane overlay. */
export function errorReason(code: string): string {
  switch (code) {
    case 'disabled':
      return 'The terminal is turned off for this workspace.'
    case 'unauthorized':
      return 'Unauthorized — the terminal token did not match.'
    case 'unavailable':
      return 'The terminal is unavailable on this platform.'
    default:
      return `Terminal error: ${code}`
  }
}

/** A short status-pill label for an error state. The full sentence lives in the
 *  pane overlay, so the header pill must NOT repeat it (F-008). `null` (a raw
 *  transport failure with no server code) reads as "Offline". */
export function errorShort(code: string | null): string {
  switch (code) {
    case 'disabled':
      return 'Off'
    case 'unauthorized':
      return 'Unauthorized'
    case 'unavailable':
      return 'Unavailable'
    default:
      return 'Offline'
  }
}
