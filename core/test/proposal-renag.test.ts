// core/test/proposal-renag.test.ts — P5-FU-3: a dismissed source_key re-surfaces
// after 7 days when its signal RECURS; inside the window it stays sticky; the
// open cap still binds; 'done' keys never re-nag.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db } from '../src/db.js'
import { persistProposals, RENAG_AFTER_MS, OPEN_PROPOSAL_CAP, type ProposalCandidate } from '../src/proposal-collectors.js'

function cand(key: string): ProposalCandidate {
  return { source: 'ci_failed', sourceKey: key, title: `t-${key}`, body: null, projectId: null }
}
function seed(key: string, status: string, updatedAt: number): void {
  db.prepare(`INSERT INTO work_items (id, title, status, scope, source, source_key, created_at, updated_at)
              VALUES (?, 't', ?, 'org', 'ci_failed', ?, ?, ?)`)
    .run(randomUUID(), status, key, updatedAt, updatedAt)
}
const rowOf = (key: string) => db.prepare(`SELECT status, updated_at FROM work_items WHERE source_key = ?`).get(key) as { status: string; updated_at: number } | undefined

beforeEach(() => { db.prepare(`DELETE FROM work_items WHERE source_key LIKE 'renag:%'`).run() })
afterAll(() => { db.prepare(`DELETE FROM work_items WHERE source_key LIKE 'renag:%'`).run() })

describe('P5-FU-3 re-nag window', () => {
  it('re-surfaces a cancelled key dismissed more than RENAG_AFTER_MS ago', () => {
    const now = Date.now()
    seed('renag:old', 'cancelled', now - RENAG_AFTER_MS - 60_000)
    const n = persistProposals([cand('renag:old')], now)
    expect(n).toBe(1) // counted as landed (broadcasts proposal_update)
    expect(rowOf('renag:old')!.status).toBe('blocked')
    expect(rowOf('renag:old')!.updated_at).toBe(now)
  })
  it('stays sticky inside the window and for done rows', () => {
    const now = Date.now()
    seed('renag:fresh', 'cancelled', now - RENAG_AFTER_MS + 60_000)
    seed('renag:done', 'done', now - RENAG_AFTER_MS - 60_000)
    expect(persistProposals([cand('renag:fresh'), cand('renag:done')], now)).toBe(0)
    expect(rowOf('renag:fresh')!.status).toBe('cancelled')
    expect(rowOf('renag:done')!.status).toBe('done')
  })
  it('the open cap binds re-surfacing too', () => {
    const now = Date.now()
    for (let i = 0; i < OPEN_PROPOSAL_CAP; i++) seed(`renag:cap-${i}`, 'blocked', now)
    seed('renag:capped-out', 'cancelled', now - RENAG_AFTER_MS - 60_000)
    expect(persistProposals([cand('renag:capped-out')], now)).toBe(0)
    expect(rowOf('renag:capped-out')!.status).toBe('cancelled')
  })
})
