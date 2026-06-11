import { describe, it, expect } from 'vitest'
import { eventBus } from '../src/events.js'
import type { WsMessage } from '@k/shared'

describe('eventBus.broadcast', () => {
  it('delivers messages to subscribers and unsubscribes cleanly', () => {
    const seen: WsMessage[] = []
    const unsub = eventBus.onBroadcast(m => seen.push(m))
    const msg: WsMessage = { type: 'github_update', projectId: 'p1', kind: 'ci', payload: { ok: true } }
    eventBus.broadcast(msg)
    unsub()
    eventBus.broadcast(msg)
    expect(seen).toEqual([msg])
  })

  it('a throwing subscriber does not break others', () => {
    const seen: WsMessage[] = []
    const unsubBad = eventBus.onBroadcast(() => { throw new Error('boom') })
    const unsubGood = eventBus.onBroadcast(m => seen.push(m))
    eventBus.broadcast({ type: 'ping' })
    unsubBad(); unsubGood()
    expect(seen).toEqual([{ type: 'ping' }])
  })
})
