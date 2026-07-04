/**
 * RunTimeline autoscroll (F-080): the replay was blind — Play/scrub moved the
 * footer counter and dimmed future rows but never scrolled, so the active row sat
 * thousands of px off-screen. The cursor row must scroll into view on seek AND on
 * play.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { AgentEvent } from '@k/shared'

vi.mock('../src/lib/api', () => ({ api: { runs: { eventRaw: async () => null } } }))

import RunTimeline from '../src/components/RunTimeline'

function ev(seq: number): AgentEvent {
  return { id: `e${seq}`, runId: 'r', seq, type: 'assistant', ts: seq * 1000, text: `#${seq}` }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('RunTimeline — cursor autoscroll', () => {
  it('scrolls the cursor row into view when the scrubber seeks', () => {
    const events = [ev(0), ev(1), ev(2), ev(3)]
    render(<RunTimeline events={events} runId="r" />)
    const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    spy.mockClear() // ignore the initial mount scroll-to-end

    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '1' } })

    expect(spy).toHaveBeenCalled()
    // The element scrolled is the cursor row (seq 1 → text "#1").
    const scrolledEl = spy.mock.instances.at(-1) as HTMLElement
    expect(scrolledEl.textContent).toContain('#1')
  })

  it('scrolls into view as Play advances the cursor', () => {
    vi.useFakeTimers()
    try {
      const events = [ev(0), ev(1), ev(2)]
      render(<RunTimeline events={events} runId="r" />)
      const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
      // Restart-from-start then play (cursor begins at the last index on mount).
      fireEvent.click(screen.getByText('Play'))
      spy.mockClear()
      act(() => { vi.advanceTimersByTime(2000) })
      expect(spy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
