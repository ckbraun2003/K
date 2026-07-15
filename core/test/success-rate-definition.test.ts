// core/test/success-rate-definition.test.ts — BE-3a: Overview 80% vs Charts 34.7%.
// Root cause: OverviewTab averaged per-DAY rates unweighted; Charts weighted by
// terminal runs. This pins the ONE definition: done/terminal over the whole window.
import { describe, it, expect } from 'vitest'
import { aggregateRouting, buildQualityTimeseries, overallSuccessRate, type RoutingRunRow } from '../src/metrics.js'

const DAY = 86_400_000
const now = Date.UTC(2026, 6, 14, 12) // noon keeps every fixture row inside local calendar days

function run(daysAgo: number, status: string): RoutingRunRow {
  return {
    created_at: now - daysAgo * DAY, ended_at: now - daysAgo * DAY + 1000, status,
    provider: 'claude', model: 'm', cost_usd: 0.01, parked_ms: 0,
  } as RoutingRunRow
}

// The divergent fixture: day-2 has ONE done run (100%); day-1 has 20 runs, 6 done (30%).
const rows: RoutingRunRow[] = [
  run(2, 'done'),
  ...Array.from({ length: 6 }, () => run(1, 'done')),
  ...Array.from({ length: 14 }, () => run(1, 'error')),
]

describe('overallSuccessRate — the single definition', () => {
  it('is terminal-weighted and equals the routing aggregate, NOT the mean of daily rates', () => {
    const points = buildQualityTimeseries(rows, now, 3).points
    const weighted = overallSuccessRate(points)!
    expect(weighted).toBeCloseTo(7 / 21, 10)
    // identical to what Charts derives from aggregateRouting groups
    const groups = aggregateRouting(rows, now).groups
    const denom = groups.reduce((s, g) => s + g.terminalRuns, 0)
    const chartsNumber = groups.reduce((s, g) => s + g.terminalRuns * g.successRate, 0) / denom
    expect(weighted).toBeCloseTo(chartsNumber, 10)
    // and provably NOT the old Overview math on the same data
    const daily = points.filter(p => p.successRate != null).map(p => p.successRate as number)
    const meanOfDays = daily.reduce((a, b) => a + b, 0) / daily.length // (1.0 + 0.3)/2 = 0.65
    expect(meanOfDays).toBeCloseTo(0.65, 10)
    expect(Math.abs(weighted - meanOfDays)).toBeGreaterThan(0.25)
  })
  it('ignores null/zero-terminal days and returns null when nothing terminal', () => {
    expect(overallSuccessRate([])).toBeNull()
    expect(overallSuccessRate([{ terminalRuns: 0, successRate: null }])).toBeNull()
  })
})
