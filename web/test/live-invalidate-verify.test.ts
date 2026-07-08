/**
 * makeVerifyInvalidator (E-04, P1 Task 9/B2) — the verify-chip live policy:
 * a `verify_update` message invalidates exactly ['run-verify', runId] (the
 * FROZEN chip cache key — ReviewDeck's header re-renders through the same
 * cache); every other message type invalidates nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WsMessage } from '@k/shared'
import { makeVerifyInvalidator } from '../src/lib/live-invalidate'

const verifyUpdate = (runId: string) =>
  ({ type: 'verify_update', result: { runId } as never }) as WsMessage

describe('makeVerifyInvalidator', () => {
  it('verify_update invalidates ["run-verify", runId] and nothing else', () => {
    const qc = { invalidateQueries: vi.fn() }
    makeVerifyInvalidator(qc as never)(verifyUpdate('r1'))
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['run-verify', 'r1'] })
  })

  it('keys the invalidation on the message run, not a fixed id', () => {
    const qc = { invalidateQueries: vi.fn() }
    makeVerifyInvalidator(qc as never)(verifyUpdate('r-other'))
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['run-verify', 'r-other'] })
  })

  it('other message types invalidate nothing', () => {
    const qc = { invalidateQueries: vi.fn() }
    const handler = makeVerifyInvalidator(qc as never)
    handler({ type: 'pong' } as WsMessage)
    handler({ type: 'run_update', run: { id: 'r1', status: 'done' } as never } as WsMessage)
    handler({ type: 'capabilities_update', scannedAt: 1 } as WsMessage)
    expect(qc.invalidateQueries).not.toHaveBeenCalled()
  })
})
