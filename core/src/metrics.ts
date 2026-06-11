/** Pure metrics aggregation over run rows — no DB, no clock. */

import type { MetricsSummary, DailyMetric } from '@k/shared'

export interface RunRow {
  created_at: number
  status: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

const DAY = 86_400_000

function localDateKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function summarizeRuns(rows: RunRow[], now: number): MetricsSummary {
  const buckets = new Map<string, DailyMetric>()
  for (let i = 13; i >= 0; i--) {
    const key = localDateKey(now - i * DAY)
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
