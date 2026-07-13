import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db, proposalsDb } from '../src/db.js'
import { persistProposals, OPEN_PROPOSAL_CAP } from '../src/proposal-collectors.js'
import type { ProposalCandidate } from '../src/proposal-collectors.js'

// A distinct source_key namespace so this suite's seeded proposals are unambiguously
// cleanable in afterAll (the shared K_DATA_DIR is not wiped between test files).
const KEY_NS = 'p5b-pc-test:'
const cand = (k: string): ProposalCandidate => ({ source: 'verify_finding', sourceKey: `${KEY_NS}${k}`, title: `fix ${k}`, body: null, projectId: null })

describe('persistProposals', () => {
  beforeEach(() => { db.prepare(`DELETE FROM work_items`).run() })
  // M2: remove ONLY this suite's seeded proposals (scoped to its source_key namespace) so a
  // leaked blocked-org work_item doesn't pollute a later suite's inbox/proposal count. These
  // rows have no run_id / FK children, so a single scoped delete is FK-safe.
  afterAll(() => { db.prepare(`DELETE FROM work_items WHERE source_key LIKE '${KEY_NS}%'`).run() })
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
    const row = proposalsDb.getProposalBySourceKey.get(`${KEY_NS}z`) as any
    expect(row.status).toBe('blocked'); expect(row.scope).toBe('org'); expect(row.source).toBe('verify_finding')
  })
})
