/** P4 A2 — deterministic Overview math (NO LLM, NO price coupling — pure numbers). */
import { describe, it, expect } from 'vitest'
import { computeDelta, computeDeltas, detectAnomalies } from '../src/lib/insights-deltas'

describe('computeDelta', () => {
  it('null baseline when previous is 0 (never divide by zero)', () => {
    expect(computeDelta({ key: 'c', label: 'Cost', current: 5, previous: 0 }).deltaPct).toBeNull()
  })
  it('trend + tone respect higherIsBetter', () => {
    const cost = computeDelta({ key: 'c', label: 'Cost', current: 12, previous: 10, higherIsBetter: false })
    expect(cost.trend).toBe('up'); expect(cost.tone).toBe('bad')       // cost up = bad
    const succ = computeDelta({ key: 's', label: 'Success', current: 0.9, previous: 0.8, higherIsBetter: true })
    expect(succ.trend).toBe('up'); expect(succ.tone).toBe('good')      // success up = good
    const flat = computeDelta({ key: 'r', label: 'Runs', current: 100, previous: 100, higherIsBetter: true })
    expect(flat.trend).toBe('flat'); expect(flat.tone).toBe('neutral')
  })
  it('computeDeltas maps a batch', () => {
    expect(computeDeltas([{ key: 'a', label: 'A', current: 2, previous: 1 }]).length).toBe(1)
  })
})

describe('detectAnomalies', () => {
  it('flags a latest spike >=2sigma into the bad tail', () => {
    const spike = detectAnomalies([{ key: 'lat', label: 'Latency', series: [10, 10, 10, 10, 40], badTail: 'high' }])
    expect(spike[0].severity === 'warn' || spike[0].severity === 'critical').toBe(true)
    expect(spike[0].z).toBeGreaterThan(0)
  })
  it('a success-rate DROP flags on the low tail', () => {
    const drop = detectAnomalies([{ key: 'sr', label: 'Success', series: [0.95, 0.96, 0.95, 0.94, 0.4], badTail: 'low' }])
    expect(drop.length).toBe(1)
  })
  it('no anomaly for <3 points or zero variance', () => {
    expect(detectAnomalies([{ key: 'x', label: 'X', series: [1, 2], badTail: 'high' }])).toEqual([])
    expect(detectAnomalies([{ key: 'y', label: 'Y', series: [5, 5, 5, 5], badTail: 'high' }])).toEqual([])
  })
})
