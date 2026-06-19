/** Pure auth-exemption predicate — pathname match, immune to query/dot-segment tricks. */
// '/ws/terminal' is exempt from the header hook because a browser WebSocket
// cannot send an Authorization header; its handler validates a `token` query
// param via terminalGate instead (and is gated off unless ENABLE_TERMINAL=true).
const PUBLIC_PATHS = new Set(['/ws', '/ws/terminal', '/health'])

export function isAuthExempt(url: string): boolean {
  try {
    return PUBLIC_PATHS.has(new URL(url, 'http://localhost').pathname)
  } catch {
    return false
  }
}
