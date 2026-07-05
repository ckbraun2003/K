/**
 * makeCapabilitiesInvalidator (wave C4) — the capability/skill-draft live
 * policy: `capabilities_update` → invalidate the ['capabilities'] prefix;
 * a TERMINAL run_update matching a cached draft's runId → invalidate that
 * ['skill-draft', id] (+ its evals + the list). Cache-miss and non-terminal
 * runs invalidate nothing; other messages are ignored.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WsMessage, SkillDraft } from '@k/shared'
import { makeCapabilitiesInvalidator } from '../src/lib/live-invalidate'

const capabilitiesUpdate = { type: 'capabilities_update', scannedAt: 1 } as WsMessage
const otherMsg = { type: 'pong' } as WsMessage
const doneRun = (id: string) => ({ type: 'run_update', run: { id, status: 'done' } as never }) as WsMessage
const runningRun = (id: string) =>
  ({ type: 'run_update', run: { id, status: 'running' } as never }) as WsMessage

function draft(over: Partial<SkillDraft> & Pick<SkillDraft, 'id'>): SkillDraft {
  return {
    nameHint: null,
    brief: 'b',
    skillMd: null,
    revision: 0,
    status: 'drafting',
    runId: null,
    savedSkillId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** Fake qc: getQueriesData answers per key prefix like react-query would. */
function makeQc(opts: { details?: SkillDraft[]; list?: SkillDraft[] }) {
  const invalidateQueries = vi.fn()
  const getQueriesData = vi.fn((filter: { queryKey: unknown[] }) => {
    if (filter.queryKey[0] === 'skill-draft') {
      return (opts.details ?? []).map(d => [['skill-draft', d.id], d])
    }
    if (filter.queryKey[0] === 'skill-drafts') {
      return opts.list !== undefined ? [[['skill-drafts'], opts.list]] : []
    }
    return []
  })
  return { invalidateQueries, getQueriesData }
}

function invalidatedKeys(spy: ReturnType<typeof vi.fn>): unknown[][] {
  return spy.mock.calls.map(c => (c[0] as { queryKey: unknown[] }).queryKey)
}

describe('makeCapabilitiesInvalidator', () => {
  it('capabilities_update invalidates the ["capabilities"] prefix and nothing else', () => {
    const qc = makeQc({})
    makeCapabilitiesInvalidator(qc as never)(capabilitiesUpdate)
    expect(invalidatedKeys(qc.invalidateQueries)).toEqual([['capabilities']])
    expect(qc.getQueriesData).not.toHaveBeenCalled()
  })

  it('a TERMINAL run_update matching a cached draft DETAIL invalidates the draft + evals + list', () => {
    const qc = makeQc({ details: [draft({ id: 'd1', runId: 'r1' })] })
    makeCapabilitiesInvalidator(qc as never)(doneRun('r1'))
    const keys = invalidatedKeys(qc.invalidateQueries)
    expect(keys).toContainEqual(['skill-draft', 'd1'])
    expect(keys).toContainEqual(['skill-draft-evals', 'd1'])
    expect(keys).toContainEqual(['skill-drafts'])
    expect(keys).toHaveLength(3)
  })

  it('a draft known only through the cached LIST is matched too', () => {
    const qc = makeQc({ list: [draft({ id: 'd2', runId: 'r2' }), draft({ id: 'd3', runId: 'r3' })] })
    makeCapabilitiesInvalidator(qc as never)(doneRun('r3'))
    const keys = invalidatedKeys(qc.invalidateQueries)
    expect(keys).toContainEqual(['skill-draft', 'd3'])
    expect(keys).not.toContainEqual(['skill-draft', 'd2'])
  })

  it('a matching draft in BOTH caches invalidates once (deduped)', () => {
    const d = draft({ id: 'd1', runId: 'r1' })
    const qc = makeQc({ details: [d], list: [d] })
    makeCapabilitiesInvalidator(qc as never)(doneRun('r1'))
    const draftKeys = invalidatedKeys(qc.invalidateQueries).filter(k => k[0] === 'skill-draft')
    expect(draftKeys).toEqual([['skill-draft', 'd1']])
  })

  it('a NON-terminal run_update invalidates nothing (no cache scan cost either)', () => {
    const qc = makeQc({ details: [draft({ id: 'd1', runId: 'r1' })] })
    makeCapabilitiesInvalidator(qc as never)(runningRun('r1'))
    expect(qc.invalidateQueries).not.toHaveBeenCalled()
    expect(qc.getQueriesData).not.toHaveBeenCalled()
  })

  it('a terminal run matching NO cached draft invalidates nothing', () => {
    const qc = makeQc({ details: [draft({ id: 'd1', runId: 'r1' })], list: [] })
    makeCapabilitiesInvalidator(qc as never)(doneRun('r-unrelated'))
    expect(qc.invalidateQueries).not.toHaveBeenCalled()
  })

  it('ignores unrelated message types', () => {
    const qc = makeQc({})
    makeCapabilitiesInvalidator(qc as never)(otherMsg)
    expect(qc.invalidateQueries).not.toHaveBeenCalled()
  })
})
