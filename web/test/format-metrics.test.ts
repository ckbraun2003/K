import { describe, it, expect } from 'vitest'
import {
  formatCompact,
  formatUsd,
  tileValue,
  weightedSuccessRate,
  weightedErrorRate,
  weightedAvgLatencyMs,
} from '../src/lib/format-metrics'

describe('formatCompact', () => {
  it('formats plain, thousands, and millions', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(1_000)).toBe('1.0k')
    expect(formatCompact(1_400)).toBe('1.4k')
    expect(formatCompact(1_200_000)).toBe('1.2M')
  })
  it('rounds sub-thousand values to an integer', () => {
    expect(formatCompact(12.4)).toBe('12')
    expect(formatCompact(12.6)).toBe('13')
  })
  it('handles negatives by magnitude', () => {
    expect(formatCompact(-1500)).toBe('-1.5k')
  })
  it('guards non-finite input', () => {
    expect(formatCompact(NaN)).toBe('—')
    expect(formatCompact(Infinity)).toBe('—')
    expect(formatCompact(-Infinity)).toBe('—')
  })
})

describe('formatUsd', () => {
  it('always shows two decimals', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(12.5)).toBe('$12.50')
    expect(formatUsd(1.239)).toBe('$1.24')
  })
  it('guards non-finite input', () => {
    expect(formatUsd(NaN)).toBe('$0.00')
    expect(formatUsd(Infinity)).toBe('$0.00')
  })
})

describe('tileValue', () => {
  it("shows an em-dash while loading so a cold load doesn't read as a real zero", () => {
    // The whole point: a genuine-looking "$0.00" / "0" must NOT show before data arrives.
    expect(tileValue(true, '$0.00')).toBe('—')
    expect(tileValue(true, '0')).toBe('—')
    expect(tileValue(true, '12')).toBe('—')
  })
  it('passes the formatted value through once loaded — including a genuine zero', () => {
    expect(tileValue(false, '$0.00')).toBe('$0.00')
    expect(tileValue(false, '0')).toBe('0')
    expect(tileValue(false, '$12.50')).toBe('$12.50')
  })
})

describe('weightedSuccessRate', () => {
  it('is 0 for an empty list (no divide-by-zero)', () => {
    expect(weightedSuccessRate([])).toBe(0)
  })
  it('weights by TERMINAL runs, not total runs — non-terminal runs cannot drag it down', () => {
    // Group A: 100 runs but 0 terminal (all active) → contributes nothing.
    // Group B: 10 terminal runs, all done (successRate 1) → the only signal.
    const rate = weightedSuccessRate([
      { terminalRuns: 0, successRate: 0 },
      { terminalRuns: 10, successRate: 1 },
    ])
    expect(rate).toBe(1) // NOT (0 + 10*1)/110 ≈ 0.09 that a runs-weighting would give
  })
  it('computes Σdone/Σterminal across groups', () => {
    // A: 10 terminal @ 0.9 = 9 done; B: 30 terminal @ 0.5 = 15 done → 24/40 = 0.6
    const rate = weightedSuccessRate([
      { terminalRuns: 10, successRate: 0.9 },
      { terminalRuns: 30, successRate: 0.5 },
    ])
    expect(rate).toBeCloseTo(0.6, 6)
  })
  it('is 0 when no group has terminal runs', () => {
    expect(weightedSuccessRate([{ terminalRuns: 0, successRate: 0 }])).toBe(0)
  })
})

describe('weightedErrorRate', () => {
  it('is 0 for an empty list and when no group has terminal runs (no divide-by-zero)', () => {
    expect(weightedErrorRate([])).toBe(0)
    expect(weightedErrorRate([{ terminalRuns: 0, errorRate: 0 }])).toBe(0)
  })
  it('weights by TERMINAL runs — non-terminal groups cannot drag it', () => {
    // Group A: 0 terminal (all active) → contributes nothing. Group B: 10 terminal @ 0.2.
    expect(
      weightedErrorRate([
        { terminalRuns: 0, errorRate: 0 },
        { terminalRuns: 10, errorRate: 0.2 },
      ]),
    ).toBeCloseTo(0.2, 9)
  })
  it('computes Σerrored/Σterminal across groups', () => {
    // A: 10 terminal @ 0.1 = 1 errored; B: 30 terminal @ 0.5 = 15 → 16/40 = 0.4
    expect(
      weightedErrorRate([
        { terminalRuns: 10, errorRate: 0.1 },
        { terminalRuns: 30, errorRate: 0.5 },
      ]),
    ).toBeCloseTo(0.4, 9)
  })
  it('is the exact complement of weightedSuccessRate over the same terminal population', () => {
    const groups = [
      { terminalRuns: 10, successRate: 0.9, errorRate: 0.1 },
      { terminalRuns: 30, successRate: 0.5, errorRate: 0.5 },
    ]
    expect(weightedSuccessRate(groups) + weightedErrorRate(groups)).toBeCloseTo(1, 9)
  })
})

describe('weightedAvgLatencyMs', () => {
  it('is 0 for an empty list and when no group has latency samples', () => {
    expect(weightedAvgLatencyMs([])).toBe(0)
    expect(weightedAvgLatencyMs([{ latencyCount: 0, avgLatencyMs: 0 }])).toBe(0)
  })
  it('weights by latency-sample count', () => {
    // A: 1 sample @ 1000ms; B: 3 samples @ 3000ms → (1000 + 9000)/4 = 2500
    expect(
      weightedAvgLatencyMs([
        { latencyCount: 1, avgLatencyMs: 1000 },
        { latencyCount: 3, avgLatencyMs: 3000 },
      ]),
    ).toBe(2500)
  })
})
