import { describe, it, expect } from 'vitest'
import {
  formatAbsTime,
  formatRelTime,
  clampDelay,
  MIN_REPLAY_DELAY_MS,
  MAX_REPLAY_DELAY_MS,
} from '../src/components/RunTimeline'

describe('clampDelay', () => {
  it('clamps below the floor up to MIN', () => {
    expect(clampDelay(0)).toBe(MIN_REPLAY_DELAY_MS)
    expect(clampDelay(50)).toBe(MIN_REPLAY_DELAY_MS)
    expect(clampDelay(-100)).toBe(MIN_REPLAY_DELAY_MS)
  })

  it('clamps above the ceiling down to MAX', () => {
    expect(clampDelay(5000)).toBe(MAX_REPLAY_DELAY_MS)
    expect(clampDelay(1001)).toBe(MAX_REPLAY_DELAY_MS)
  })

  it('passes through values inside the window', () => {
    expect(clampDelay(120)).toBe(120)
    expect(clampDelay(500)).toBe(500)
    expect(clampDelay(1000)).toBe(1000)
  })
})

describe('formatRelTime', () => {
  it('renders +0.0s for the first event offset', () => {
    expect(formatRelTime(0)).toBe('+0.0s')
  })

  it('renders one decimal place', () => {
    expect(formatRelTime(12_340)).toBe('+12.3s')
    expect(formatRelTime(1_000)).toBe('+1.0s')
    expect(formatRelTime(550)).toBe('+0.6s') // rounds to one decimal
  })
})

describe('formatAbsTime', () => {
  it('formats as HH:MM:SS.mmm with zero-padding (local time)', () => {
    // build a local timestamp so the assertion is timezone-independent
    const ts = new Date(2026, 5, 12, 9, 4, 7, 30).getTime()
    expect(formatAbsTime(ts)).toBe('09:04:07.030')
  })

  it('pads milliseconds to three digits', () => {
    const ts = new Date(2026, 0, 1, 23, 59, 59, 5).getTime()
    expect(formatAbsTime(ts)).toBe('23:59:59.005')
  })
})
