/** FE-7 UIP-FU-3 — cost-today vs-yesterday delta. Pure, no fabricated %:
 *  null when there's no yesterday bucket or yesterday was a zero-spend day. */
import { describe, it, expect } from 'vitest'
import { costTodayDelta } from '../src/pages/home/widgets/CostTodayWidget'

describe('costTodayDelta', () => {
  const day = (k: string, c: number) => ({ key: k, label: k, costUsd: c, runs: 1 })
  it('computes the vs-yesterday percentage', () => {
    expect(costTodayDelta([day('2026-07-14', 2), day('2026-07-13', 1)], '2026-07-14', '2026-07-13')).toEqual({ pct: 100, polarity: 'badUp' })
  })
  it('is null with no yesterday bucket or zero yesterday (no fabricated %)', () => {
    expect(costTodayDelta([day('2026-07-14', 2)], '2026-07-14', '2026-07-13')).toBeNull()
    expect(costTodayDelta([day('2026-07-14', 2), day('2026-07-13', 0)], '2026-07-14', '2026-07-13')).toBeNull()
  })
})
