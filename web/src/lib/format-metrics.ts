// Small pure formatters for the Metrics KPI tiles. Kept out of the page so the
// JSX stays readable and the rounding rules live in one testable place.

/** Compact count formatter for tokens: 1_400 → "1.4k", 1_200_000 → "1.2M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** USD formatter for KPI tiles: 12.5 → "$12.50" (always 2 decimals). */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  return `$${n.toFixed(2)}`
}

/** KPI-tile value gate: render an em-dash while the feed is still loading so a cold
 *  load never reads as a REAL zero ("$0.00 today" / "0 runs"). Once loaded the
 *  formatted value shows through — including a genuine zero (F-083). */
export function tileValue(isLoading: boolean, value: string): string {
  return isLoading ? '—' : value
}

/**
 * Org-wide success rate (0..1) from per-model routing stats: Σdone/Σterminal,
 * computed as Σ(terminalRuns·successRate)/Σ(terminalRuns). Weighted by the SAME
 * denominator each per-group rate uses (terminal count) — NOT total runs — so
 * non-terminal (active/queued) runs never drag it down. 0 when no terminal runs.
 */
export function weightedSuccessRate(groups: ReadonlyArray<{ terminalRuns: number; successRate: number }>): number {
  const denom = groups.reduce((s, g) => s + g.terminalRuns, 0)
  if (denom <= 0) return 0
  return groups.reduce((s, g) => s + g.terminalRuns * g.successRate, 0) / denom
}

/**
 * Org-wide error rate (0..1) from per-model routing stats: Σ(errored)/Σterminal,
 * computed as Σ(terminalRuns·errorRate)/Σ(terminalRuns). Weighted by the SAME
 * killed-excluded terminal denominator as weightedSuccessRate — so the two are exact
 * complements (successRate + errorRate === 1 over the terminal population). 0 when no
 * terminal runs (W9b F-085).
 */
export function weightedErrorRate(groups: ReadonlyArray<{ terminalRuns: number; errorRate: number }>): number {
  const denom = groups.reduce((s, g) => s + g.terminalRuns, 0)
  if (denom <= 0) return 0
  return groups.reduce((s, g) => s + g.terminalRuns * g.errorRate, 0) / denom
}

/**
 * Org-wide mean latency (ms): Σ(latencyCount·avgLatencyMs)/Σ(latencyCount) —
 * weighted by the count of runs that actually carry a latency sample (the same
 * denominator the per-group mean uses). 0 when no run has a usable latency.
 */
export function weightedAvgLatencyMs(groups: ReadonlyArray<{ latencyCount: number; avgLatencyMs: number }>): number {
  const denom = groups.reduce((s, g) => s + g.latencyCount, 0)
  if (denom <= 0) return 0
  return groups.reduce((s, g) => s + g.latencyCount * g.avgLatencyMs, 0) / denom
}

/** Wall-clock duration of a FINISHED run ("4s" / "2m 34s" / "2h 1m"); null while open. */
export function runDuration(run: { createdAt: number; endedAt?: number }): string | null {
  if (run.endedAt == null || run.endedAt <= run.createdAt) return null
  const s = Math.round((run.endedAt - run.createdAt) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
