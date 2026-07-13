import { describe, it, expect, beforeEach } from 'vitest'
import { db, proposalsDb } from '../src/db.js'
import { persistProposals, OPEN_PROPOSAL_CAP } from '../src/proposal-collectors.js'
import type { ProposalCandidate } from '../src/proposal-collectors.js'

const cand = (k: string): ProposalCandidate => ({ source: 'verify_finding', sourceKey: k, title: `fix ${k}`, body: null, projectId: null })

describe('persistProposals', () => {
  beforeEach(() => { db.prepare(`DELETE FROM work_items`).run() })
  it('dedupes by source_key', () => {
    expect(persistProposals([cand('a'), cand('a')])).toBe(1)
    expect(persistProposals([cand('a')])).toBe(0) // already exists
    expect((proposalsDb.countOpenProposals.get() as any).n).toBe(1)
  })
  it('respects the open-proposal cap', () => {
    const many = Array.from({ length: OPEN_PROPOSAL_CAP + 5 }, (_, i) => cand(`k${i}`))
    persistProposals(many)
    expect((proposalsDb.countOpenProposals.get() as any).n).toBe(OPEN_PROPOSAL_CAP)
  })
  it('creates blocked+org+sourced rows', () => {
    persistProposals([cand('z')])
    const row = proposalsDb.getProposalBySourceKey.get('z') as any
    expect(row.status).toBe('blocked'); expect(row.scope).toBe('org'); expect(row.source).toBe('verify_finding')
  })
})
