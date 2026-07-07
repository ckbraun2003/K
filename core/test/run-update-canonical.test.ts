/**
 * Lane C (P0) — E-11 canonical status attaches at the emit boundary.
 *
 * events.ts::emitRunUpdate must push a run whose `canonical` triple equals
 * canonicalizeRunStatus(status) for EVERY RunStatus — the WS gateway forwards
 * subscriber payloads verbatim, so this is exactly what the wire carries.
 * The legacy `status` discriminator must pass through unchanged.
 */
import { describe, it, expect } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { Run } from '@k/shared'
import { RunStatusSchema, canonicalizeRunStatus } from '@k/shared'
import { eventBus } from '../src/events.js'

function makeRun(status: Run['status']): Run {
  return {
    id: uuid(), prompt: 'p', cwd: 'C:/tmp', status, provider: 'claude',
    model: 'claude-haiku-4-5-20251001', tokensIn: 0, tokensOut: 0, costUsd: 0,
    createdAt: Date.now(),
  }
}

describe('emitRunUpdate canonical enrichment', () => {
  it('attaches the canonical triple for every RunStatus; status unchanged', () => {
    for (const status of RunStatusSchema.options) {
      let received: Run | undefined
      const unsub = eventBus.onRunUpdate(r => { received = r })
      eventBus.emitRunUpdate(makeRun(status)) // UPDATE on an unknown id is a 0-row no-op — safe
      unsub()
      expect(received, `status ${status}`).toBeDefined()
      expect(received!.canonical).toEqual(canonicalizeRunStatus(status))
      expect(received!.status).toBe(status)
    }
  })
})
