import type { Finding, VerificationReport } from '@k/shared'

// Severity render order: most-urgent first.
export const SEVERITY_ORDER = ['critical', 'warn', 'info'] as const
export type Severity = (typeof SEVERITY_ORDER)[number]

// Weighted max points per breakdown component (mirrors core verify.ts).
export const BREAKDOWN_MAX = { ci: 40, coverage: 20, bible: 20, findings: 20 } as const
export type BreakdownKey = keyof typeof BREAKDOWN_MAX

// Human labels + iteration order for the breakdown bars.
export const BREAKDOWN_BARS: { key: BreakdownKey; label: string }[] = [
  { key: 'ci', label: 'CI' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'bible', label: 'Bible' },
  { key: 'findings', label: 'Findings' },
]

// Group findings by severity into critical → warn → info order, preserving
// input order within each bucket. Severities with no findings are omitted.
export function groupFindings(findings: Finding[]): { severity: Severity; items: Finding[] }[] {
  return SEVERITY_ORDER.map(severity => ({
    severity,
    items: findings.filter(f => f.severity === severity),
  })).filter(g => g.items.length > 0)
}

// Fraction [0,1] of a breakdown value against its weighted max. Clamped so a
// malformed/over-max value can never blow past a full bar.
export function barPct(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

// Relative-time hint for a unix-ms timestamp. Returns "never verified" when
// absent. This is distinct from RunTimeline.formatRelTime (which formats a ms
// offset as "+12.3s") — here we want a coarse calendar-ish "3d ago".
export function formatTimeAgo(ts: number | undefined, now: number = Date.now()): string {
  if (ts == null) return 'never verified'
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return 'verified just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `verified ${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `verified ${hr}h ago`
  const day = Math.floor(hr / 24)
  return `verified ${day}d ago`
}

// Color token suffix per severity (named tokens — safe with Tailwind alpha).
export const SEVERITY_DOT: Record<Severity, string> = {
  critical: 'bg-[var(--red)]',
  warn: 'bg-[var(--amber)]',
  info: 'bg-[var(--green)]',
}

// Most-recent report from a newest-first list (defensive: re-sorts by startedAt).
export function latestReport(reports: VerificationReport[]): VerificationReport | undefined {
  if (reports.length === 0) return undefined
  return [...reports].sort((a, b) => b.startedAt - a.startedAt)[0]
}
