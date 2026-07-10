import type { Finding, VerificationReport } from '@k/shared'
import { healthRubric } from './health'

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
// malformed/over-max value can never blow past a full bar. A null value (the
// dimension was UNMEASURED — excluded from the score) renders as an empty bar.
export function barPct(value: number | null, max: number): number {
  if (value == null || max <= 0) return 0
  const r = Math.max(0, Math.min(1, value / max))
  return Number.isFinite(r) ? r : 0
}

// Coarse calendar-ish relative time string ("3d ago", "just now").
// Distinct from RunTimeline.formatRelTime which formats a ms offset as "+12.3s".
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return 'unknown'
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// Verification-context wrapper: prepends "verified" or returns "never verified".
export function formatTimeAgo(ts: number | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return 'never verified'
  const rel = relativeTime(ts, now)
  return rel === 'just now' ? 'verified just now' : `verified ${rel}`
}

// Score → Tailwind color class. null (insufficient signal — no dimension measured)
// renders muted, matching the "—" the UI shows for a null score.
export function scoreColor(score: number | null): string {
  return healthRubric(score).text
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

// Score-trend marker for a report vs the chronologically-previous one: ' ▲' improved,
// ' ▼' regressed, ' =' unchanged, '' when there is no prior report. Shared by the
// workspace Verification tab AND the standalone verify page so the two render the
// history identically (F-052 — the '=' delta marker previously existed only on the tab).
export function trendIndicator(reports: VerificationReport[], id: string): string {
  const sorted = [...reports].sort((a, b) => b.startedAt - a.startedAt)
  const idx = sorted.findIndex(r => r.id === id)
  if (idx < 0 || idx === sorted.length - 1) return ''
  const prev = sorted[idx + 1].score
  const curr = sorted[idx].score
  // No trend when either report had insufficient signal (null score) — nothing to compare.
  if (prev == null || curr == null) return ''
  if (curr > prev) return ' ▲'
  if (curr < prev) return ' ▼'
  return ' ='
}
