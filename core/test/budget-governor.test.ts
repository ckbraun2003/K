// core/test/budget-governor.test.ts
import { describe, it, expect } from 'vitest'
import { classifyBudget } from '../src/budget-governor.js'

describe('classifyBudget', () => {
  it('no cap → always ok', () => {
    expect(classifyBudget(null, 999, 0.8)).toBe('ok')
  })
  it('warns at warnPct, caps at the cap', () => {
    expect(classifyBudget(10, 7, 0.8)).toBe('ok')     // 7 < 8
    expect(classifyBudget(10, 8, 0.8)).toBe('warn')   // 8 >= 8, < 10
    expect(classifyBudget(10, 10, 0.8)).toBe('capped')
    expect(classifyBudget(10, 12, 0.8)).toBe('capped')
  })
  it('zero cap caps immediately', () => {
    expect(classifyBudget(0, 0, 0.8)).toBe('capped')
  })
})
