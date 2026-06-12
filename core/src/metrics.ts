/** Pure metrics aggregation over run rows — no DB, no clock. */

import type { MetricsSummary, DailyMetric, MetricsTimeseries, TimeseriesGroupBy } from '@k/shared'

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

export function summarizeRuns(rows: RunRow[], now: number): MetricsSummary {
  const buckets = new Map<string, DailyMetric>()
  // calendar-day arithmetic (not fixed 24h offsets) so DST transitions can't
  // skip a day: new Date(y, m, d - i) normalizes to the actual local calendar day
  const t = new Date(now)
  for (let i = 13; i >= 0; i--) {
    const key = localDateKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i).getTime())
    buckets.set(key, { date: key, runs: 0, tokens: 0, costUsd: 0 })
  }
  let activeRuns = 0
  for (const r of rows) {
    if (r.status === 'running' || r.status === 'queued') activeRuns++
    const b = buckets.get(localDateKey(r.created_at))
    if (!b) continue // older than the window
    b.runs++
    b.tokens += r.tokens_in + r.tokens_out
    b.costUsd += r.cost_usd
  }
  const daily = [...buckets.values()]
  return {
    today: daily[daily.length - 1],
    activeRuns,
    totalRuns: rows.length,
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
