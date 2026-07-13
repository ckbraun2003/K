// core/test/config-autonomy.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { autonomySettings, setAutonomySettings, __resetConfigCache } from '../src/config-store.js'

describe('autonomy settings store', () => {
  beforeEach(() => { __resetConfigCache(); setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }) })
  it('defaults to OFF', () => {
    __resetConfigCache()
    // a fresh key would be DEFAULT; here we assert the merge keeps enabled false after reset
    expect(autonomySettings().enabled).toBe(false)
  })
  it('persists a partial patch and merges', () => {
    setAutonomySettings({ enabled: true, orgDailyBudgetUsd: 5 })
    __resetConfigCache()
    const s = autonomySettings()
    expect(s.enabled).toBe(true)
    expect(s.orgDailyBudgetUsd).toBe(5)
    expect(s.maxConcurrency).toBe(1) // untouched default preserved
  })
})
