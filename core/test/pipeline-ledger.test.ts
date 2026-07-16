/**
 * orch-p2 Lane A / Task A.1 — pipeline progress ledger writer (TOKEN-FREE, DB-only).
 *
 * The ledger is an append-only per-pipeline-run feed (design §6.1). appendLedger assigns a
 * monotonic per-run `seq` inside a single txn (MAX(seq)+1) so two writers from different stages
 * can never collide on UNIQUE(pipeline_run_id, seq); listLedger reads a run's feed ordered by seq.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { appendLedger, listLedger } from '../src/pipeline-ledger.js'

describe('pipeline ledger writer (A.1)', () => {
  it('assigns a monotonic per-run seq starting at 1', () => {
    const run = randomUUID()
    const a = appendLedger(run, { kind: 'transition', goal: 'first' })
    const b = appendLedger(run, { kind: 'note', goal: 'second' })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.pipelineRunId).toBe(run)
  })

  it('scopes seq per run (independent counters, no cross-run collision)', () => {
    const r1 = randomUUID()
    const r2 = randomUUID()
    const a1 = appendLedger(r1, { kind: 'transition' })
    const b1 = appendLedger(r2, { kind: 'transition' })
    const a2 = appendLedger(r1, { kind: 'note' })
    expect(a1.seq).toBe(1)
    expect(b1.seq).toBe(1)
    expect(a2.seq).toBe(2)
  })

  it('listLedger returns entries ordered by seq, each seq unique', () => {
    const run = randomUUID()
    for (let i = 0; i < 6; i++) appendLedger(run, { kind: 'transition', goal: `g${i}` })
    const rows = listLedger(run)
    expect(rows.map(r => r.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(new Set(rows.map(r => r.seq)).size).toBe(6)
    expect(rows.map(r => r.goal)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g5'])
  })

  it('round-trips stageKey / actor / cost / detail JSON', () => {
    const run = randomUUID()
    const e = appendLedger(run, {
      stageKey: 'impl', kind: 'cost', actor: 'implementer', cost: 0.42,
      detail: { model: 'opus', tokens: 12 },
    })
    const [row] = listLedger(run)
    expect(row.stageKey).toBe('impl')
    expect(row.kind).toBe('cost')
    expect(row.actor).toBe('implementer')
    expect(row.cost).toBe(0.42)
    expect(row.detail).toEqual({ model: 'opus', tokens: 12 })
    // the returned entry mirrors what was persisted
    expect(e.detail).toEqual({ model: 'opus', tokens: 12 })
    expect(e.stageKey).toBe('impl')
  })

  it('defaults optional fields to null (stageKey / actor / goal / cost / no detail)', () => {
    const run = randomUUID()
    const e = appendLedger(run, { kind: 'note' })
    expect(e.stageKey).toBeNull()
    expect(e.actor).toBeNull()
    expect(e.goal).toBeNull()
    expect(e.cost).toBeNull()
    expect(e.detail).toBeUndefined()
    const [row] = listLedger(run)
    expect(row.stageKey).toBeNull()
    expect(row.detail).toBeUndefined()
  })
})
