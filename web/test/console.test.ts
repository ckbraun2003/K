import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@k/shared'
import { mergeEvents } from '../src/components/RunConsole'

function ev(seq: number, id = `e${seq}`): AgentEvent {
  return { id, runId: 'r', seq, type: 'assistant', ts: seq, text: `#${seq}` }
}

describe('mergeEvents — backfill + live ordering', () => {
  it('dedupes live events already present in history (by id)', () => {
    const history = [ev(1), ev(2), ev(3)]
    const live = [ev(2), ev(3), ev(4)]
    const merged = mergeEvents(history, live)
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('re-sorts by seq when live events arrived out of order', () => {
    const history = [ev(1), ev(2)]
    // live events that landed out of order while backfill was in flight
    const live = [ev(5), ev(3), ev(4)]
    const merged = mergeEvents(history, live)
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('orders correctly when a late live event has a lower seq than history tail', () => {
    const history = [ev(2), ev(4)]
    const live = [ev(3), ev(1)]
    const merged = mergeEvents(history, live)
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('returns sorted history unchanged when there are no live events', () => {
    const history = [ev(1), ev(2), ev(3)]
    expect(mergeEvents(history, []).map(e => e.seq)).toEqual([1, 2, 3])
  })
})
