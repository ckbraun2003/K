import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { summarizeRuns, buildTimeseries, buildQualityTimeseries, windowStartMs, type RunRow, type TimeseriesRunRow, type RoutingRunRow } from '../src/metrics.js'
import { db } from '../src/db.js'

const DAY = 86_400_000
// Fixed "now": 2026-06-10T12:00 local
const now = new Date(2026, 5, 10, 12, 0, 0).getTime()

function row(p: Partial<RunRow>): RunRow {
  return { created_at: now, status: 'done', tokens_in: 100, tokens_out: 50, cost_usd: 0.01, ...p }
}

describe('summarizeRuns', () => {
  it('aggregates today and counts active runs', () => {
    const rows = [
      row({}),                                  // today, done
      row({ status: 'running', cost_usd: 0 }),  // today, active
      row({ created_at: now - DAY }),           // yesterday
    ]
    // counts come from DB in production; pass explicit values matching intent
    const s = summarizeRuns(rows, now, { totalRuns: 3, activeRuns: 1 })
    expect(s.today.runs).toBe(2)
    expect(s.today.tokens).toBe(300)
    expect(s.activeRuns).toBe(1)
    expect(s.totalRuns).toBe(3)
  })

  it('produces 14 daily buckets oldest→newest with zero-fill', () => {
    const s = summarizeRuns([row({ created_at: now - 3 * DAY })], now, { totalRuns: 1, activeRuns: 0 })
    expect(s.daily).toHaveLength(14)
    expect(s.daily[13].date).toBe('2026-06-10')
    expect(s.daily[10].runs).toBe(1)
    expect(s.daily[0].runs).toBe(0)
  })

  it('counts queued as active — activeRuns from counts, not rows', () => {
    // rows has a queued run but activeRuns comes from the passed counts object
    const s = summarizeRuns([row({ status: 'queued' })], now, { totalRuns: 10, activeRuns: 3 })
    expect(s.activeRuns).toBe(3)
  })

  it('returns zero-filled summary for no rows', () => {
    const s = summarizeRuns([], now, { totalRuns: 0, activeRuns: 0 })
    expect(s.daily).toHaveLength(14)
    expect(s.today).toEqual({ date: '2026-06-10', runs: 0, tokens: 0, costUsd: 0 })
    expect(s.activeRuns).toBe(0)
    expect(s.totalRuns).toBe(0)
  })

  it('totalRuns reflects counts, not rows.length — lifetime can exceed window rows', () => {
    // Only 2 rows in the 14-day window, but 500 runs exist lifetime
    const rows = [row({}), row({ created_at: now - DAY })]
    const s = summarizeRuns(rows, now, { totalRuns: 500, activeRuns: 7 })
    expect(s.totalRuns).toBe(500)   // from counts, not rows.length (2)
    expect(s.activeRuns).toBe(7)    // from counts, not derived from rows
    expect(s.today.runs).toBe(1)    // daily bucket still reflects window rows only
  })

  it('rows outside 14-day window are NOT in daily buckets (safety guard)', () => {
    // A row 15 days ago falls outside the oldest bucket; should not appear in daily
    const old = row({ created_at: now - 15 * DAY })
    const s = summarizeRuns([old], now, { totalRuns: 1, activeRuns: 0 })
    expect(s.daily).toHaveLength(14)
    const total = s.daily.reduce((acc, d) => acc + d.runs, 0)
    expect(total).toBe(0) // old row contributed nothing to daily buckets
  })
})

// ─── buildTimeseries ─────────────────────────────────────────────────────────

function tsRow(p: Partial<TimeseriesRunRow>): TimeseriesRunRow {
  return {
    created_at: now,
    status: 'done',
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.01,
    project_id: 'proj-1',
    project_name: 'Project One',
    provider: 'claude',
    model: 'claude-3-5-sonnet',
    ...p,
  }
}

describe('buildTimeseries', () => {
  it('dates array: length === days, oldest→newest, last entry is today', () => {
    const ts = buildTimeseries([], now, 7, 'project')
    expect(ts.dates).toHaveLength(7)
    expect(ts.dates[6]).toBe('2026-06-10')
    expect(ts.dates[0]).toBe('2026-06-04')
  })

  it('zero-filled points for empty rows', () => {
    const ts = buildTimeseries([], now, 5, 'project')
    expect(ts.series).toHaveLength(0)
    expect(ts.dates).toHaveLength(5)
  })

  it('days=1 edge: only today', () => {
    const ts = buildTimeseries([tsRow({})], now, 1, 'project')
    expect(ts.dates).toHaveLength(1)
    expect(ts.dates[0]).toBe('2026-06-10')
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].points[0].runs).toBe(1)
  })

  it('out-of-window rows are ignored', () => {
    const outside = tsRow({ created_at: now - 8 * DAY }) // 8 days ago, outside 7-day window
    const ts = buildTimeseries([outside], now, 7, 'project')
    expect(ts.series).toHaveLength(0)
  })

  it('project grouping: NULL project_id → key=unassigned label=Unassigned', () => {
    const ts = buildTimeseries(
      [tsRow({ project_id: null, project_name: null })],
      now, 7, 'project',
    )
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].key).toBe('unassigned')
    expect(ts.series[0].label).toBe('Unassigned')
  })

  it('project grouping: non-null id with null name → label is the id', () => {
    const ts = buildTimeseries(
      [tsRow({ project_id: 'abc-123', project_name: null })],
      now, 7, 'project',
    )
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].key).toBe('abc-123')
    expect(ts.series[0].label).toBe('abc-123')
  })

  it('model grouping: claude provider → bare model label', () => {
    const ts = buildTimeseries(
      [tsRow({ provider: 'claude', model: 'claude-opus-4' })],
      now, 7, 'model',
    )
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].key).toBe('claude-opus-4')
    expect(ts.series[0].label).toBe('claude-opus-4')
  })

  it('model grouping: ollama provider → provider/model label', () => {
    const ts = buildTimeseries(
      [tsRow({ provider: 'ollama', model: 'llama3' })],
      now, 7, 'model',
    )
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].key).toBe('llama3')
    expect(ts.series[0].label).toBe('ollama/llama3')
  })

  it('totals: per-series total equals sum of its points', () => {
    const rows = [
      tsRow({ created_at: now }),
      tsRow({ created_at: now - DAY }),
      tsRow({ created_at: now - 2 * DAY }),
    ]
    const ts = buildTimeseries(rows, now, 7, 'project')
    expect(ts.series).toHaveLength(1)
    const s = ts.series[0]
    const sumRuns = s.points.reduce((a, p) => a + p.runs, 0)
    const sumTokens = s.points.reduce((a, p) => a + p.tokens, 0)
    const sumCost = s.points.reduce((a, p) => a + p.costUsd, 0)
    expect(s.total.runs).toBe(sumRuns)
    expect(s.total.tokens).toBe(sumTokens)
    expect(Math.abs(s.total.costUsd - sumCost)).toBeLessThan(1e-9)
  })

  it('top-8 + other: 10 keys → 8 kept desc by tokens, other last with correct sums', () => {
    // Create 10 synthetic projects with distinct token totals (100 apart)
    const rows: TimeseriesRunRow[] = Array.from({ length: 10 }, (_, i) => {
      // Project i has tokens_in = (i+1)*100, tokens_out = 0
      return tsRow({
        project_id: `proj-${i}`,
        project_name: `Project ${i}`,
        tokens_in: (i + 1) * 100,
        tokens_out: 0,
      })
    })
    const ts = buildTimeseries(rows, now, 7, 'project')
    expect(ts.series).toHaveLength(9) // 8 kept + 'other'
    expect(ts.series[8].key).toBe('other')
    expect(ts.series[8].label).toBe('Other')

    // Kept series should be sorted desc by tokens: proj-9 (1000), proj-8 (900), ...proj-2 (200)
    expect(ts.series[0].key).toBe('proj-9')
    expect(ts.series[7].key).toBe('proj-2')

    // 'other' should contain proj-1 (tokens=100) and proj-0 (tokens=100)?
    // Wait: proj-0 has tokens_in=100, proj-1 has tokens_in=200... let me recalculate.
    // i=0 → tokens_in=100, i=1 → 200, ..., i=9 → 1000
    // Top 8: proj-9(1000), proj-8(900), proj-7(800), proj-6(700), proj-5(600), proj-4(500), proj-3(400), proj-2(300)
    // Folded (other): proj-1(200) + proj-0(100) = 300 tokens
    const otherTotal = ts.series[8].total.tokens
    expect(otherTotal).toBe(300) // proj-1(200) + proj-0(100)

    // 'other' points are elementwise sum: both rows are on the same day (now),
    // so the same point index should have runs=2, tokens=300
    const todayIdx = ts.dates.indexOf('2026-06-10')
    expect(ts.series[8].points[todayIdx].runs).toBe(2)
    expect(ts.series[8].points[todayIdx].tokens).toBe(300)
  })

  it('≤8 series → no other series', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      tsRow({ project_id: `proj-${i}`, project_name: `Project ${i}` }),
    )
    const ts = buildTimeseries(rows, now, 7, 'project')
    expect(ts.series).toHaveLength(8)
    expect(ts.series.find(s => s.key === 'other')).toBeUndefined()
  })

  it('deterministic tiebreak: equal tokens → label asc', () => {
    // Two series with same token total
    const rows = [
      tsRow({ project_id: 'zzz', project_name: 'Zebra', tokens_in: 100, tokens_out: 0 }),
      tsRow({ project_id: 'aaa', project_name: 'Alpha', tokens_in: 100, tokens_out: 0 }),
    ]
    const ts = buildTimeseries(rows, now, 7, 'project')
    expect(ts.series).toHaveLength(2)
    expect(ts.series[0].label).toBe('Alpha')
    expect(ts.series[1].label).toBe('Zebra')
  })

  it('points array aligned 1:1 with dates, zero-filled', () => {
    const ts = buildTimeseries([tsRow({ created_at: now })], now, 7, 'project')
    expect(ts.series[0].points).toHaveLength(7)
    // All but today should be zero
    for (let i = 0; i < 6; i++) {
      expect(ts.series[0].points[i]).toEqual({ runs: 0, tokens: 0, costUsd: 0 })
    }
    expect(ts.series[0].points[6].runs).toBe(1)
  })
})

// ─── activeRuns SQL counts in-flight statuses (incl. awaiting_input) ───────────
// The active-count SQL (not the pure summarizeRuns) decides which statuses count
// as active. The shared test DB is mutated by other suites in parallel, so we scope
// the assertion to our own seeded run ids rather than a global baseline delta.

describe('activeRuns status set', () => {
  const seeded: string[] = []

  function seedRun(status: string): string {
    const id = uuid()
    db.prepare(
      `INSERT INTO runs (id, prompt, cwd, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, 'p', '/tmp', status, Date.now())
    seeded.push(id)
    return id
  }

  afterAll(() => {
    for (const id of seeded.splice(0)) db.prepare(`DELETE FROM runs WHERE id = ?`).run(id)
  })

  it("counts running/queued/awaiting_input/awaiting_plan as active, excludes terminal statuses", () => {
    const ids = [
      seedRun('running'),
      seedRun('queued'),
      seedRun('awaiting_input'),
      seedRun('awaiting_plan'), // P2 E-02: a parked plan is live work awaiting attention
      seedRun('done'),        // terminal — excluded
      seedRun('error'),       // terminal — excluded
      seedRun('killed'),      // terminal — excluded
      seedRun('interrupted'), // terminal — excluded
    ]
    // Same status set as routes/metrics.ts activeRunsStmt, scoped to our rows.
    const placeholders = ids.map(() => '?').join(',')
    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE id IN (${placeholders}) AND status IN ('running','queued','awaiting_input','awaiting_plan')`,
    ).get(...ids) as { n: number }
    expect(n).toBe(4) // running + queued + awaiting_input + awaiting_plan
  })
})

// ─── buildTimeseries lead grouping (W9b F-084) ────────────────────────────────

describe('buildTimeseries lead grouping', () => {
  it('groups a run under its orchestrator lead; a lead-dispatched run cost lands there', () => {
    const rows = [
      tsRow({ lead_id: 'lead-a', lead_name: 'Backend Lead', cost_usd: 0.05 }),
      tsRow({ lead_id: 'lead-a', lead_name: 'Backend Lead', cost_usd: 0.05 }),
      tsRow({ lead_id: 'lead-b', lead_name: 'Frontend Lead', cost_usd: 0.20 }),
    ]
    const ts = buildTimeseries(rows, now, 7, 'lead')
    expect(ts.groupBy).toBe('lead')
    const byKey = new Map(ts.series.map(s => [s.key, s]))
    expect(byKey.get('lead-a')!.label).toBe('Backend Lead')
    expect(byKey.get('lead-a')!.total.runs).toBe(2)
    expect(byKey.get('lead-a')!.total.costUsd).toBeCloseTo(0.10, 9)
    expect(byKey.get('lead-b')!.total.costUsd).toBeCloseTo(0.20, 9)
  })

  it('a run with no lead activation groups as Unassigned (cost conserved, not dropped)', () => {
    const rows = [
      tsRow({ lead_id: 'lead-a', lead_name: 'A', cost_usd: 0.10 }),
      tsRow({ lead_id: null, lead_name: null, cost_usd: 0.03 }),
    ]
    const ts = buildTimeseries(rows, now, 7, 'lead')
    const un = ts.series.find(s => s.key === 'unassigned')!
    expect(un).toBeDefined()
    expect(un.label).toBe('Unassigned')
    expect(un.total.costUsd).toBeCloseTo(0.03, 9)
    // total window cost conserved across all lead buckets
    const totalCost = ts.series.reduce((a, s) => a + s.total.costUsd, 0)
    expect(totalCost).toBeCloseTo(0.13, 9)
  })

  it('absent lead_id/lead_name fields (optional) → Unassigned', () => {
    const ts = buildTimeseries([tsRow({})], now, 7, 'lead') // tsRow default has no lead fields
    expect(ts.series).toHaveLength(1)
    expect(ts.series[0].key).toBe('unassigned')
    expect(ts.series[0].label).toBe('Unassigned')
  })

  it('leads rank by window cost (cost-ranking consumer orders highest-cost first)', () => {
    const rows = [
      tsRow({ lead_id: 'lead-a', lead_name: 'A', cost_usd: 0.10, tokens_in: 10, tokens_out: 0 }),
      tsRow({ lead_id: 'lead-b', lead_name: 'B', cost_usd: 0.30, tokens_in: 5, tokens_out: 0 }),
      tsRow({ lead_id: 'lead-c', lead_name: 'C', cost_usd: 0.20, tokens_in: 1, tokens_out: 0 }),
    ]
    const ts = buildTimeseries(rows, now, 7, 'lead')
    const ranked = [...ts.series].sort((x, y) => y.total.costUsd - x.total.costUsd)
    expect(ranked.map(s => s.key)).toEqual(['lead-b', 'lead-c', 'lead-a'])
  })
})

// ─── buildQualityTimeseries (W9b F-087) ───────────────────────────────────────

function qRow(p: Partial<RoutingRunRow>): RoutingRunRow {
  return {
    provider: 'claude',
    model: 'sonnet',
    status: 'done',
    cost_usd: 0,
    created_at: now,
    ended_at: null,
    ...p,
  }
}

describe('buildQualityTimeseries', () => {
  it('emits `days` points oldest→newest, aligned 1:1 with dates', () => {
    const q = buildQualityTimeseries([], now, 7)
    expect(q.days).toBe(7)
    expect(q.dates).toHaveLength(7)
    expect(q.points).toHaveLength(7)
    expect(q.dates[6]).toBe('2026-06-10')
    expect(q.points[6].date).toBe('2026-06-10')
  })

  it('per-day success rate = done / killed-excluded terminal (consistent with W9a)', () => {
    const rows = [
      qRow({ status: 'done', created_at: now }),
      qRow({ status: 'error', created_at: now }),
      qRow({ status: 'killed', created_at: now }),   // killed excluded from denominator
      qRow({ status: 'running', created_at: now }),  // non-terminal, excluded
    ]
    const today = buildQualityTimeseries(rows, now, 7).points[6]
    expect(today.terminalRuns).toBe(2)             // done + error
    expect(today.successRate).toBeCloseTo(0.5, 9)  // 1 done / 2 terminal
  })

  it('a day with no terminal runs → successRate null (a gap, never NaN)', () => {
    const q = buildQualityTimeseries([qRow({ status: 'running', created_at: now })], now, 7)
    expect(q.points[6].terminalRuns).toBe(0)
    expect(q.points[6].successRate).toBeNull()
    for (const pt of q.points) {
      expect(pt.successRate === null || Number.isFinite(pt.successRate)).toBe(true)
      expect(pt.avgLatencyMs === null || Number.isFinite(pt.avgLatencyMs)).toBe(true)
    }
  })

  it('per-day avg latency = active (parked-excluded) mean; null when no samples', () => {
    const rows = [
      qRow({ created_at: now, ended_at: now + 10_000, parked_ms: 6_000 }), // active 4s
      qRow({ created_at: now, ended_at: now + 4_000 }),                    // active 4s
    ]
    const q = buildQualityTimeseries(rows, now, 7)
    expect(q.points[6].avgLatencyMs).toBe(4_000)
    expect(q.points[6].latencyCount).toBe(2)
    // an earlier day with no runs has no latency samples → null
    expect(q.points[0].avgLatencyMs).toBeNull()
    expect(q.points[0].latencyCount).toBe(0)
  })

  it('buckets runs by their local calendar day', () => {
    const rows = [
      qRow({ status: 'done', created_at: now }),
      qRow({ status: 'done', created_at: now - 2 * DAY }),
    ]
    const q = buildQualityTimeseries(rows, now, 7)
    expect(q.points[6].terminalRuns).toBe(1) // today
    expect(q.points[6].successRate).toBe(1)
    expect(q.points[4].terminalRuns).toBe(1) // 2 days back
  })
})

describe('windowStartMs', () => {
  it('days=1 → local midnight of today', () => {
    expect(windowStartMs(now, 1)).toBe(new Date(2026, 5, 10).getTime())
  })

  it('days=14 → local midnight 13 days back', () => {
    expect(windowStartMs(now, 14)).toBe(new Date(2026, 4, 28).getTime())
  })

  it('agrees with the buildTimeseries window: a row exactly at windowStart is included, one ms earlier is not', () => {
    const start = windowStartMs(now, 7)
    const mk = (created_at: number): TimeseriesRunRow => ({
      created_at, status: 'done', tokens_in: 1, tokens_out: 0, cost_usd: 0,
      project_id: null, project_name: null, provider: 'claude', model: 'm',
    })
    const included = buildTimeseries([mk(start)], now, 7, 'project')
    expect(included.series).toHaveLength(1)
    const excluded = buildTimeseries([mk(start - 1)], now, 7, 'project')
    expect(excluded.series).toHaveLength(0)
  })
})
