/** P2 W0c — the ONE parked predicate covers both park flavors. */
import { describe, it, expect } from 'vitest'
import type { Run } from '@k/shared'
import { isActiveRun, isParkedRun } from '../src/lib/runs-query'

const base: Run = {
  id: 'r', prompt: 'x', cwd: 'C:\\r', status: 'running', provider: 'claude',
  model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1,
}

describe('isParkedRun', () => {
  it('treats both awaiting_input and awaiting_plan as parked-on-a-human', () => {
    expect(isParkedRun({ ...base, status: 'awaiting_input' })).toBe(true)
    expect(isParkedRun({ ...base, status: 'awaiting_plan' })).toBe(true)
    expect(isParkedRun(base)).toBe(false)
    expect(isActiveRun({ ...base, status: 'awaiting_plan' })).toBe(false)
  })
})
