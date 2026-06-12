/** Pure auth-exemption predicate — pathname match, immune to query/dot-segment tricks. */
const PUBLIC_PATHS = new Set(['/ws', '/health'])

export function isAuthExempt(url: string): boolean {
  try {
    return PUBLIC_PATHS.has(new URL(url, 'http://localhost').pathname)
  } catch {
    return false
  }
}
