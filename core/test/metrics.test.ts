import { describe, it, expect } from 'vitest'
import { summarizeRuns, type RunRow } from '../src/metrics.js'

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
    const s = summarizeRuns(rows, now)
    expect(s.today.runs).toBe(2)
    expect(s.today.tokens).toBe(300)
    expect(s.activeRuns).toBe(1)
    expect(s.totalRuns).toBe(3)
  })

  it('produces 14 daily buckets oldest→newest with zero-fill', () => {
    const s = summarizeRuns([row({ created_at: now - 3 * DAY })], now)
    expect(s.daily).toHaveLength(14)
    expect(s.daily[13].date).toBe('2026-06-10')
    expect(s.daily[10].runs).toBe(1)
    expect(s.daily[0].runs).toBe(0)
  })

  it('counts queued as active', () => {
    const s = summarizeRuns([row({ status: 'queued' })], now)
    expect(s.activeRuns).toBe(1)
  })
})
