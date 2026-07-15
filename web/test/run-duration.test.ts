import { describe, it, expect } from 'vitest'
import { runDuration } from '../src/lib/format-metrics'

describe('runDuration', () => {
  it('formats sub-minute and minute+ durations', () => {
    expect(runDuration({ createdAt: 0, endedAt: 4_200 })).toBe('4s')
    expect(runDuration({ createdAt: 0, endedAt: 154_000 })).toBe('2m 34s')
    expect(runDuration({ createdAt: 0, endedAt: 7_260_000 })).toBe('2h 1m')
  })
  it('returns null while a run is still open (no endedAt)', () => {
    expect(runDuration({ createdAt: 0 })).toBeNull()
    expect(runDuration({ createdAt: 100, endedAt: 90 })).toBeNull() // clock skew guard
  })
})
