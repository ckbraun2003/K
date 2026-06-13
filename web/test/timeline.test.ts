import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatAbsTime,
  formatRelTime,
  clampDelay,
  shouldFetchRaw,
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

describe('shouldFetchRaw — lazy fetch guard', () => {
  // Simulates the cache + inflight state that lives in component state/refs.
  let cache: Record<number, string | null>
  let inflight: Set<number>

  beforeEach(() => {
    cache = {}
    inflight = new Set()
  })

  it('returns true when event has no inline raw and seq is uncached and not in-flight', () => {
    expect(shouldFetchRaw(1, false, cache, inflight)).toBe(true)
  })

  it('returns false when event has inline raw (live event — no fetch needed)', () => {
    expect(shouldFetchRaw(1, true, cache, inflight)).toBe(false)
  })

  it('returns false when seq is already cached (second expand should not refetch)', () => {
    cache[1] = '{"type":"assistant"}'
    expect(shouldFetchRaw(1, false, cache, inflight)).toBe(false)
  })

  it('returns false when seq is cached as null (404 result — do not retry)', () => {
    cache[1] = null
    expect(shouldFetchRaw(1, false, cache, inflight)).toBe(false)
  })

  it('returns false when seq is already in-flight (concurrent expand guard)', () => {
    inflight.add(1)
    expect(shouldFetchRaw(1, false, cache, inflight)).toBe(false)
  })
})

describe('lazy raw fetch + caching via api.runs.eventRaw mock', () => {
  it('calls eventRaw once and caches the result; second call with cached value skips fetch', async () => {
    // Minimal simulation of the component's fetch-and-cache flow using the
    // shouldFetchRaw guard — mirrors what toggleExpanded does in the component.
    const mockEventRaw = vi.fn().mockResolvedValue('{"type":"assistant"}')

    const cache: Record<number, string | null> = {}
    const inflight: Set<number> = new Set()

    async function simulateExpand(seq: number, hasRawInline: boolean) {
      if (!shouldFetchRaw(seq, hasRawInline, cache, inflight)) return
      inflight.add(seq)
      try {
        cache[seq] = await mockEventRaw('run-1', seq)
      } catch {
        cache[seq] = null
      } finally {
        inflight.delete(seq)
      }
    }

    // First expand of a raw-less backfilled event
    await simulateExpand(3, false)
    expect(mockEventRaw).toHaveBeenCalledTimes(1)
    expect(mockEventRaw).toHaveBeenCalledWith('run-1', 3)
    expect(cache[3]).toBe('{"type":"assistant"}')

    // Second expand — cache hit, no refetch
    await simulateExpand(3, false)
    expect(mockEventRaw).toHaveBeenCalledTimes(1) // still 1

    // Expanding a live event (has inline raw) — fetch never triggered
    await simulateExpand(4, true)
    expect(mockEventRaw).toHaveBeenCalledTimes(1) // still 1
  })

  it('caches null on fetch failure (404/network error) and does not retry', async () => {
    const mockEventRaw = vi.fn().mockRejectedValue(new Error('not found'))

    const cache: Record<number, string | null> = {}
    const inflight: Set<number> = new Set()

    async function simulateExpand(seq: number) {
      if (!shouldFetchRaw(seq, false, cache, inflight)) return
      inflight.add(seq)
      try {
        cache[seq] = await mockEventRaw('run-1', seq)
      } catch {
        cache[seq] = null
      } finally {
        inflight.delete(seq)
      }
    }

    await simulateExpand(5)
    expect(cache[5]).toBeNull()
    expect(mockEventRaw).toHaveBeenCalledTimes(1)

    // Retry — should be blocked by null cache entry
    await simulateExpand(5)
    expect(mockEventRaw).toHaveBeenCalledTimes(1) // no retry
  })
})
