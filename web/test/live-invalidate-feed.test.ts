/** P3 B2 — the feed invalidator fires ['feed'] on run/notification/verify traffic. */
import { describe, it, expect, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { makeFeedInvalidator } from '../src/lib/live-invalidate'

describe('makeFeedInvalidator', () => {
  it('invalidates the [feed] key on run_update / notification / verify_update', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const inv = makeFeedInvalidator(qc)
    inv({ type: 'run_update', run: { id: 'r' } } as any)
    inv({ type: 'notification', notification: { id: 'n' }, browser: false } as any)
    inv({ type: 'verify_update', result: { runId: 'r' } } as any)
    inv({ type: 'ping' } as any) // ignored
    const feedCalls = spy.mock.calls.filter(c => JSON.stringify((c[0] as any)?.queryKey) === JSON.stringify(['feed']))
    expect(feedCalls.length).toBe(3)
  })
})
