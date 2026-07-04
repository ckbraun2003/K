/** Pure metrics aggregation over run rows — no DB, no clock. */

import type {
  MetricsSummary, DailyMetric, MetricsTimeseries, TimeseriesGroupBy,
  RoutingStats, RoutingModelStat,
} from '@k/shared'
import { TERMINAL_RUN_STATUSES } from './run-lifecycle.js'

export interface RunRow {
  created_at: number
  status: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

function localDateKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** counts.totalRuns = lifetime total from DB; counts.activeRuns = running|queued from DB.
 *  rows are pre-windowed to the 14-day range — only used to populate daily buckets. */
export function summarizeRuns(
  rows: RunRow[],
  now: number,
  counts: { totalRuns: number; activeRuns: number },
): MetricsSummary {
  const buckets = new Map<string, DailyMetric>()
  // calendar-day arithmetic (not fixed 24h offsets) so DST transitions can't
  // skip a day: new Date(y, m, d - i) normalizes to the actual local calendar day
  const t = new Date(now)
  for (let i = 13; i >= 0; i--) {
    const key = localDateKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i).getTime())
    buckets.set(key, { date: key, runs: 0, tokens: 0, costUsd: 0 })
  }
  for (const r of rows) {
    const b = buckets.get(localDateKey(r.created_at))
    if (!b) continue // older than the window (safety guard; rows should be pre-windowed)
    b.runs++
    b.tokens += r.tokens_in + r.tokens_out
    b.costUsd += r.cost_usd
  }
  const daily = [...buckets.values()]
  return {
    today: daily[daily.length - 1],
    activeRuns: counts.activeRuns,
    totalRuns: counts.totalRuns,
    daily,
  }
}

// ─── Timeseries ──────────────────────────────────────────────────────────────

export interface TimeseriesRunRow extends RunRow {
  project_id: string | null
  project_name: string | null
  provider: string
  model: string
}

/** Epoch ms of local midnight `days - 1` days before `now` — the oldest instant
 *  in the window. Lets callers bound their SQL (WHERE created_at >= ?) instead of
 *  scanning the whole runs table; buildTimeseries still re-checks per row. */
export function windowStartMs(now: number, days: number): number {
  const t = new Date(now)
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() - (days - 1)).getTime()
}

export function buildTimeseries(
  rows: TimeseriesRunRow[],
  now: number,
  days: number,
  groupBy: TimeseriesGroupBy,
): MetricsTimeseries {
  // Build date window using same calendar-day arithmetic as summarizeRuns
  const t = new Date(now)
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDateKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i).getTime()))
  }
  const dateIndex = new Map<string, number>(dates.map((d, i) => [d, i]))

  // Accumulate per-series points
  const seriesMap = new Map<string, { label: string; points: { runs: number; tokens: number; costUsd: number }[] }>()

  for (const r of rows) {
    const dateKey = localDateKey(r.created_at)
    const idx = dateIndex.get(dateKey)
    if (idx === undefined) continue // outside window

    let key: string
    let label: string
    if (groupBy === 'project') {
      key = r.project_id ?? 'unassigned'
      label = r.project_name ?? (r.project_id ?? 'Unassigned')
    } else {
      key = r.model
      label = r.provider === 'claude' ? r.model : `${r.provider}/${r.model}`
    }

    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        label,
        points: dates.map(() => ({ runs: 0, tokens: 0, costUsd: 0 })),
      })
    }
    const entry = seriesMap.get(key)!
    // Update label in case a later row has a name for the same key
    entry.label = label
    entry.points[idx].runs++
    entry.points[idx].tokens += r.tokens_in + r.tokens_out
    entry.points[idx].costUsd += r.cost_usd
  }

  // Build series with totals
  type SeriesWithTotal = {
    key: string
    label: string
    points: { runs: number; tokens: number; costUsd: number }[]
    total: { runs: number; tokens: number; costUsd: number }
  }

  const allSeries: SeriesWithTotal[] = []
  for (const [key, { label, points }] of seriesMap) {
    const total = points.reduce(
      (acc, p) => ({ runs: acc.runs + p.runs, tokens: acc.tokens + p.tokens, costUsd: acc.costUsd + p.costUsd }),
      { runs: 0, tokens: 0, costUsd: 0 },
    )
    allSeries.push({ key, label, points, total })
  }

  // Sort by total.tokens desc, then label asc as tiebreak
  allSeries.sort((a, b) => {
    if (b.total.tokens !== a.total.tokens) return b.total.tokens - a.total.tokens
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })

  // Keep top 8; fold the rest into 'other'
  const MAX_SERIES = 8
  let series: SeriesWithTotal[]
  if (allSeries.length <= MAX_SERIES) {
    series = allSeries
  } else {
    const kept = allSeries.slice(0, MAX_SERIES)
    const folded = allSeries.slice(MAX_SERIES)
    // Elementwise sum for 'other' points
    const otherPoints = dates.map((_, i) =>
      folded.reduce(
        (acc, s) => ({ runs: acc.runs + s.points[i].runs, tokens: acc.tokens + s.points[i].tokens, costUsd: acc.costUsd + s.points[i].costUsd }),
        { runs: 0, tokens: 0, costUsd: 0 },
      ),
    )
    const otherTotal = otherPoints.reduce(
      (acc, p) => ({ runs: acc.runs + p.runs, tokens: acc.tokens + p.tokens, costUsd: acc.costUsd + p.costUsd }),
      { runs: 0, tokens: 0, costUsd: 0 },
    )
    series = [...kept, { key: 'other', label: 'Other', points: otherPoints, total: otherTotal }]
  }

  return { groupBy, days, dates, series }
}

// ─── Routing stats ─────────────────────────────────────────────────────────

export interface RoutingRunRow {
  provider: string
  model: string
  status: string
  cost_usd: number
  created_at: number
  ended_at: number | null
  /** Total ms this run sat PARKED at awaiting_input (summed awaiting_input→next-status
   *  intervals — computed in SQL, see routes/metrics.ts). Subtracted from wall-clock so
   *  avgLatencyMs reflects active processing time, not operator think-time (F-082).
   *  Optional/absent → treated as 0 (a run that never parked). */
  parked_ms?: number
}

// Minimum total run history before we'll suggest a routing change.
const RECOMMEND_MIN_RUNS = 10

/** Plain-language routing recommendation derived purely from the aggregated
 *  groups. Deterministic and unit-testable. */
export function routingRecommendation(groups: RoutingModelStat[]): string {
  const totalRuns = groups.reduce((sum, g) => sum + g.runs, 0)
  if (totalRuns < RECOMMEND_MIN_RUNS) {
    return 'Not enough run history yet to recommend a routing change.'
  }

  const ollama = groups.filter(g => g.provider === 'ollama')
  const claude = groups.filter(g => g.provider === 'claude')

  if (claude.length > 0 && ollama.length === 0) {
    return 'All runs went to Claude — local (Ollama) routing is unused or disabled. Enabling it could cut cost on low-risk tasks.'
  }

  if (ollama.length > 0 && claude.length > 0) {
    // Best (highest success rate) group on each side.
    const bestOllama = ollama.reduce((a, b) => (b.successRate > a.successRate ? b : a))
    const bestClaude = claude.reduce((a, b) => (b.successRate > a.successRate ? b : a))
    // Local is free; recommend preferring it when its success rate is within a
    // small margin of Claude's (or better).
    if (bestOllama.successRate >= bestClaude.successRate - 0.05) {
      const local = `${bestOllama.provider}/${bestOllama.model}`
      const localPct = Math.round(bestOllama.successRate * 100)
      const claudePct = Math.round(bestClaude.successRate * 100)
      return `Local ${local} matches Claude on success (${localPct}% vs ${claudePct}%) at $0 cost — prefer it for low-risk tasks.`
    }
    return 'Claude is outperforming local models on success rate; keep routing risky tasks to Claude.'
  }

  // ollama only (claude.length === 0, guaranteed by the branches above)
  if (ollama.length > 0 && claude.length === 0) {
    return 'All runs went to local models at $0 cost. Routing is already cost-optimal for the observed workload.'
  }

  // Unreachable for the claude|ollama provider enum, but stay accurate (rather
  // than implying "no history") if a future provider ever appears in the data.
  return 'No routing recommendation available for the current provider mix.'
}

/** Pure per-(provider,model) outcome aggregation. `now` is used only for
 *  generatedAt (mirrors summarizeRuns). */
export function aggregateRouting(rows: RoutingRunRow[], now: number): RoutingStats {
  type Acc = {
    provider: string
    model: string
    runs: number
    terminal: number
    done: number
    costSum: number       // over all runs (totalCostUsd)
    costPosSum: number    // over runs with cost_usd > 0
    costPosCount: number
    latencySum: number
    latencyCount: number
  }
  const accs = new Map<string, Acc>()

  for (const r of rows) {
    const key = `${r.provider} ${r.model}`
    let a = accs.get(key)
    if (!a) {
      a = {
        provider: r.provider, model: r.model, runs: 0, terminal: 0, done: 0,
        costSum: 0, costPosSum: 0, costPosCount: 0, latencySum: 0, latencyCount: 0,
      }
      accs.set(key, a)
    }
    a.runs++
    // successRate denominator EXCLUDES operator-killed runs (F-082): a kill is an
    // operator decision, not a task failure, so a killed run counts as NEITHER
    // success nor failure. done/error/interrupted remain the terminal population —
    // consistent with weightedSuccessRate weighting by this same terminal count.
    if (TERMINAL_RUN_STATUSES.has(r.status) && r.status !== 'killed') {
      a.terminal++
      if (r.status === 'done') a.done++
    }
    a.costSum += r.cost_usd
    if (r.cost_usd > 0) { a.costPosSum += r.cost_usd; a.costPosCount++ }
    // Latency = ACTIVE processing time = wall-clock (ended_at - created_at) minus the
    // time the run sat parked at awaiting_input (parked_ms). Excludes operator
    // think-time so an interactive/HITL run's latency reflects work, not waiting
    // (F-082). Clamp to 0 against clock skew / parked > wall; still counted (it ended).
    if (r.ended_at != null && r.ended_at >= r.created_at) {
      const parked = r.parked_ms != null && r.parked_ms > 0 ? r.parked_ms : 0
      a.latencySum += Math.max(0, (r.ended_at - r.created_at) - parked)
      a.latencyCount++
    }
  }

  const groups: RoutingModelStat[] = [...accs.values()].map(a => ({
    provider: a.provider,
    model: a.model,
    runs: a.runs,
    terminalRuns: a.terminal,
    successRate: a.terminal > 0 ? a.done / a.terminal : 0,
    avgCostUsd: a.costPosCount > 0 ? a.costPosSum / a.costPosCount : 0,
    totalCostUsd: a.costSum,
    avgLatencyMs: a.latencyCount > 0 ? a.latencySum / a.latencyCount : 0,
    latencyCount: a.latencyCount,
  }))

  groups.sort((a, b) => {
    if (b.runs !== a.runs) return b.runs - a.runs
    const ka = `${a.provider} ${a.model}`
    const kb = `${b.provider} ${b.model}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  return {
    generatedAt: now,
    totalRuns: rows.length,
    groups,
    recommendation: routingRecommendation(groups),
  }
}
