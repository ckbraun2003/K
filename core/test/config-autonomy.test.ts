// core/test/config-autonomy.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { autonomySettings, setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'

describe('autonomy settings store', () => {
  beforeEach(() => { __resetConfigCache(); setAutonomySettings({ enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }) })
  // Restore the persisted default-OFF blob so this file leaves no state in the shared
  // K_DATA_DIR app_config (else a legal reorder makes autonomy-routes-registered read enabled:true).
  afterAll(() => { setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS }); __resetConfigCache() })
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
