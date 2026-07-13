import { describe, it, expect, beforeEach } from 'vitest'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { wakeChief, resetChiefWakeDebounce } from '../src/chief-wake.js'

const OFF = { enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }

describe('chief wake reads the persisted setting', () => {
  beforeEach(() => { __resetConfigCache(); resetChiefWakeDebounce(); setAutonomySettings(OFF); delete process.env.CHIEF_WAKE })
  it('is DISABLED by default (settings off) regardless of env', async () => {
    const r = await wakeChief('schedule', {})
    expect(r).toEqual({ woke: false, reason: 'disabled' })
  })
  it('env CHIEF_WAKE=1 does NOT enable it (settings are the source of truth)', async () => {
    process.env.CHIEF_WAKE = '1'
    const r = await wakeChief('schedule', {})
    expect(r.woke).toBe(false)
  })
})
