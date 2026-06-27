import type { Status } from '@k/shared'

/** A traffic-light verdict for one status card. `tone` maps to a midnight-glass
 *  CSS var (--green/--amber/--red) — never an invented colour. */
export type StatusTone = 'green' | 'amber' | 'red'

export interface StatusVerdict {
  tone: StatusTone
  /** Short status word for the dot's label, e.g. "Available", "Unreachable". */
  label: string
  /** One-line detail (version / user / url) — may be empty. */
  detail: string
}

/** CSS var for a tone — single palette, no hard-coded hex. */
export function toneColor(tone: StatusTone): string {
  return tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--red)'
}

export function claudeVerdict(c: Status['claude']): StatusVerdict {
  return c.available
    ? { tone: 'green', label: 'Available', detail: c.version ?? '' }
    : { tone: 'red', label: 'Not found', detail: 'claude binary not on PATH' }
}

export function ollamaVerdict(o: Status['ollama']): StatusVerdict {
  if (!o.enabled) return { tone: 'amber', label: 'Disabled', detail: 'ENABLE_OLLAMA not set' }
  return o.reachable
    ? { tone: 'green', label: 'Reachable', detail: `${o.model} @ ${o.baseUrl}` }
    : { tone: 'red', label: 'Unreachable', detail: o.baseUrl }
}

export function githubVerdict(g: Status['github']): StatusVerdict {
  return g.authenticated
    ? { tone: 'green', label: 'Authenticated', detail: g.user ? `as ${g.user}` : '' }
    : { tone: 'red', label: 'Unauthenticated', detail: 'gh absent or not logged in' }
}

export function authVerdict(a: Status['auth']): StatusVerdict {
  // Green when loopback-only OR a strong env token guards a remote host; amber
  // (advisory) when bound to a non-loopback host — the operator should be sure a
  // proxy/Tailscale fronts it. tokenSource never carries the token value.
  const src = a.tokenSource === 'env' ? 'HARNESS_TOKEN env' : 'generated/persisted'
  if (a.loopbackOnly) {
    return { tone: 'green', label: 'Loopback only', detail: `${a.host} · token: ${src}` }
  }
  return { tone: 'amber', label: 'Network-exposed', detail: `${a.host} · token: ${src}` }
}
