/**
 * Campaign S1 — EventBus emitEvent / emitRunUpdate (LOCK / characterization).
 * Extends events.test.ts (which only covers broadcast) to the persisted seams:
 *
 *  - emitEvent persists the row AND notifies onEvent subscribers (persist-first,
 *    so a crash right after does not lose the event) (S1-022).
 *  - A throwing onEvent subscriber is isolated — other subscribers still fire and
 *    emitEvent does not throw (S1-023).
 *  - emitRunUpdate persists the run's status/usage AND notifies onRunUpdate
 *    subscribers, with the same subscriber isolation (S1-024).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { AgentEvent, Run } from '@k/shared'
import { db, runsDb, eventsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'

const runIds: string[] = []

function mkRun(status = 'queued'): string {
  const id = uuid()
  runsDb.insertRun.run({
    id, prompt: 'p', cwd: '/tmp', worktree: null, status, provider: 'claude',
    model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now(),
  })
  runIds.push(id)
  return id
}

afterAll(() => {
  for (const id of runIds) {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
})

describe('S1 — eventBus.emitEvent persists and notifies', () => {
  it('persists the event row and delivers it to onEvent subscribers', () => {
    const runId = mkRun()
    const seen: AgentEvent[] = []
    const unsub = eventBus.onEvent(e => seen.push(e))
    const ev: AgentEvent = {
      id: uuid(), runId, seq: 1, type: 'assistant', ts: Date.now(), text: 'hello',
    } as AgentEvent
    eventBus.emitEvent(ev)
    unsub()

    // delivered live
    expect(seen).toHaveLength(1)
    expect(seen[0].id).toBe(ev.id)
    // and persisted
    const rows = eventsDb.listEvents.all(runId) as Array<{ seq: number; text: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('hello')
  })

  it('a throwing subscriber does not break others or emitEvent', () => {
    const runId = mkRun()
    const seen: string[] = []
    const unsubBad = eventBus.onEvent(() => { throw new Error('boom') })
    const unsubGood = eventBus.onEvent(e => seen.push(e.id))
    const ev = { id: uuid(), runId, seq: 1, type: 'status', ts: Date.now() } as AgentEvent
    expect(() => eventBus.emitEvent(ev)).not.toThrow()
    unsubBad(); unsubGood()
    expect(seen).toEqual([ev.id])
  })
})

describe('S1 — eventBus.emitRunUpdate persists status and notifies', () => {
  it('writes status/usage to the run row and delivers to onRunUpdate subscribers', () => {
    const runId = mkRun('queued')
    const seen: Run[] = []
    const unsub = eventBus.onRunUpdate(r => seen.push(r))
    const update: Run = {
      id: runId, status: 'done', tokensIn: 11, tokensOut: 22, costUsd: 0.5, endedAt: Date.now(),
    } as Run
    eventBus.emitRunUpdate(update)
    unsub()

    expect(seen).toHaveLength(1)
    const row = runsDb.getRun.get(runId) as {
      status: string; tokens_in: number; tokens_out: number; cost_usd: number; ended_at: number | null
    }
    expect(row.status).toBe('done')
    expect(row.tokens_in).toBe(11)
    expect(row.tokens_out).toBe(22)
    expect(row.cost_usd).toBe(0.5)
    expect(row.ended_at).not.toBeNull()
  })

  it('a throwing run subscriber is isolated', () => {
    const runId = mkRun('queued')
    const seen: string[] = []
    const unsubBad = eventBus.onRunUpdate(() => { throw new Error('boom') })
    const unsubGood = eventBus.onRunUpdate(r => seen.push(r.id))
    const update = { id: runId, status: 'failed', tokensIn: 0, tokensOut: 0, costUsd: 0, endedAt: Date.now() } as Run
    expect(() => eventBus.emitRunUpdate(update)).not.toThrow()
    unsubBad(); unsubGood()
    expect(seen).toEqual([runId])
  })
})
