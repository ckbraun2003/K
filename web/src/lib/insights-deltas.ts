/**
 * P4 E-10 Overview — DETERMINISTIC deltas + anomaly detection. Pure threshold math over
 * MEASURED metric series (cost_usd totals, run counts, success rates, latency ms). NO LLM,
 * NO price coupling (operates only on already-measured numbers). The Overview tab adapts the
 * server metrics summary/quality/routing into these shape-agnostic inputs.
 */
export type Trend = 'up' | 'down' | 'flat'
export type Tone = 'good' | 'bad' | 'neutral'

export interface DeltaInput {
  key: string
  label: string
  current: number
  previous: number
  /** whether a higher current value is GOOD (success rate) or BAD (cost/latency). Drives tone. */
  higherIsBetter?: boolean
}
export interface DeltaResult extends DeltaInput {
  deltaPct: number | null // null when previous === 0 (no baseline — never divide by zero)
  trend: Trend
  tone: Tone
}

const FLAT_EPS = 0.001 // < 0.1% swing reads as flat

export function computeDelta(input: DeltaInput): DeltaResult {
  const { current, previous, higherIsBetter } = input
  const deltaPct = previous === 0 ? null : (current - previous) / previous
  const trend: Trend =
    deltaPct === null ? (current > 0 ? 'up' : 'flat')
    : deltaPct > FLAT_EPS ? 'up' : deltaPct < -FLAT_EPS ? 'down' : 'flat'
  let tone: Tone = 'neutral'
  if (trend !== 'flat' && higherIsBetter !== undefined) {
    const improving = (trend === 'up') === higherIsBetter
    tone = improving ? 'good' : 'bad'
  }
  return { ...input, deltaPct, trend, tone }
}

export function computeDeltas(inputs: DeltaInput[]): DeltaResult[] {
  return inputs.map(computeDelta)
}

export interface AnomalyInput {
  key: string
  label: string
  series: number[] // chronological measured series (per-day success rate / latency / cost)
  badTail: 'low' | 'high' // which tail is bad: success rate = 'low', cost/latency = 'high'
}
export interface Anomaly {
  key: string
  label: string
  value: number // the latest point
  mean: number
  z: number // signed z-score of the latest point vs the series
  severity: 'warn' | 'critical'
  reason: string
}

/**
 * Flag the LATEST point when it deviates >= 2 sigma (warn) / >= 3 sigma (critical) into the bad
 * tail. Deterministic; needs >= 3 points and non-zero variance, else no anomaly.
 */
export function detectAnomalies(inputs: AnomalyInput[]): Anomaly[] {
  const out: Anomaly[] = []
  for (const { key, label, series, badTail } of inputs) {
    if (series.length < 3) continue
    const value = series[series.length - 1]
    const mean = series.reduce((a, b) => a + b, 0) / series.length
    const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length
    const sd = Math.sqrt(variance)
    if (sd === 0) continue
    const z = (value - mean) / sd
    const bad = badTail === 'low' ? -z : z // magnitude into the bad direction
    // Decide at the SAME 0.1-sigma precision the reason string reports (toFixed(1)), so a point
    // rendered as "2.0 sigma below" is treated as meeting the 2-sigma bar (a raw 1.9992 that
    // rounds to 2.0 flags; avoids a floating-point boundary miss inconsistent with the display).
    const badR = Math.round(bad * 10) / 10
    if (badR < 2) continue
    const severity: Anomaly['severity'] = badR >= 3 ? 'critical' : 'warn'
    const dir = badTail === 'low' ? 'below' : 'above'
    out.push({ key, label, value, mean, z, severity, reason: `latest ${label} is ${bad.toFixed(1)} sigma ${dir} the ${series.length}-point mean` })
  }
  return out
}
