import { describe, it, expect } from 'vitest'
import type { SkillRun } from '../src/lib/skill-runs'
import { sortSkillRunsNewestFirst, newestSkillRun } from '../src/lib/skill-runs'

function sr(startedAt: number, id = `s${startedAt}`): SkillRun {
  return {
    id,
    skillId: 'skill-1',
    runId: `run-${id}`,
    triggeredBy: 'manual',
    startedAt,
    completedAt: null,
    status: 'done',
  }
}

describe('sortSkillRunsNewestFirst', () => {
  it('orders by startedAt descending', () => {
    const runs = [sr(1), sr(3), sr(2)]
    expect(sortSkillRunsNewestFirst(runs).map(r => r.startedAt)).toEqual([3, 2, 1])
  })

  it('does not mutate the input array', () => {
    const runs = [sr(1), sr(2)]
    sortSkillRunsNewestFirst(runs)
    expect(runs.map(r => r.startedAt)).toEqual([1, 2])
  })

  it('handles an empty list', () => {
    expect(sortSkillRunsNewestFirst([])).toEqual([])
  })
})

describe('newestSkillRun', () => {
  it('returns the run with the greatest startedAt', () => {
    expect(newestSkillRun([sr(5), sr(9), sr(2)])?.startedAt).toBe(9)
  })

  it('returns undefined for an empty list', () => {
    expect(newestSkillRun([])).toBeUndefined()
  })
})
