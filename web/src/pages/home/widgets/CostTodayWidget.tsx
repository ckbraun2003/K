import { useQuery } from '@tanstack/react-query'
import type { CostRollup } from '@k/shared'
import { api } from '../../../lib/api'
import MetricCard from '../../../components/MetricCard'

const COST_ROLLUP_DAYS = 14

// Prefixed with 'metrics' (not a bespoke top-level key) so the Shell-level
// `run_update` invalidator's `qc.invalidateQueries({ queryKey: ['metrics'] })`
// (live-invalidate.ts) reaches this cache entry too — a completed run's cost
// shows up here live, not only on reload.
const COST_TODAY_KEY = ['metrics', 'cost-rollup', 'day', COST_ROLLUP_DAYS] as const

/** sqlite's `date(created_at/1000,'unixepoch')` (core/src/routes/metrics.ts
 *  rollupDayStmt) has no 'localtime' modifier, so bucket keys are UTC
 *  calendar days — match with the same UTC slice, not a local Date field. */
function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * CostTodayWidget (UI Simplification Task 13) — MEASURED actuals only (D-087):
 * today's billed `cost_usd` total + a 14-day daily sparkline, read from the
 * existing `GET /api/metrics/cost-rollup?groupBy=day` endpoint (`api.metrics.
 * costRollup`, already bound — no new endpoint). This file never hardcodes a
 * $-per-unit rate and never multiplies a token count by one (the D-087 grep
 * gate under core/test enforces exactly that across core/src and web/src).
 *
 * A day with zero runs never appears in the sparse `buckets` array (the
 * server only emits rows GROUP BY day WHERE runs exist) — if today has no
 * matching bucket yet, the headline reads $0.0000 rather than borrowing the
 * most-recent day's total under a "today" label (D-026 honesty posture).
 */
export default function CostTodayWidget() {
  const { data } = useQuery<CostRollup>({
    queryKey: COST_TODAY_KEY,
    queryFn: () => api.metrics.costRollup({ days: COST_ROLLUP_DAYS, groupBy: 'day' }),
  })
  const buckets = data?.buckets ?? []
  const today = buckets.find(b => b.key === todayUtcKey())
  const todayCostUsd = today?.costUsd ?? 0
  // Server returns buckets key DESC (most recent first) — reverse to chronological for the sparkline.
  const spark = [...buckets].reverse().map(b => b.costUsd)

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3" data-testid="widget-cost-today">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Cost today</h2>
      <MetricCard label="Measured, billed" value={`$${todayCostUsd.toFixed(4)}`} spark={spark} accent />
    </div>
  )
}
