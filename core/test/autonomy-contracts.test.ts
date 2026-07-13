// core/test/autonomy-contracts.test.ts
import { describe, it, expect } from 'vitest'
import {
  AutonomySettingsSchema, DEFAULT_AUTONOMY_SETTINGS, AutonomyPatchBodySchema,
  BudgetStatusSchema, FailureClassSchema, RetryRateSeriesSchema, InboxItemKindSchema,
} from '@k/shared'

describe('autonomy contracts', () => {
  it('default settings parse and are OFF', () => {
    expect(AutonomySettingsSchema.parse(DEFAULT_AUTONOMY_SETTINGS).enabled).toBe(false)
  })
  it('rejects an empty patch and an out-of-range concurrency', () => {
    expect(AutonomyPatchBodySchema.safeParse({}).success).toBe(false)
    expect(AutonomySettingsSchema.safeParse({ ...DEFAULT_AUTONOMY_SETTINGS, maxConcurrency: 0 }).success).toBe(false)
  })
  it('inbox kinds include proposal', () => {
    expect(InboxItemKindSchema.options).toContain('proposal')
  })
  it('budget + retry + failure-class shapes parse', () => {
    expect(FailureClassSchema.parse('transient')).toBe('transient')
    expect(RetryRateSeriesSchema.parse({ windowDays: 14, points: [], overallRate: 0 }).windowDays).toBe(14)
    expect(BudgetStatusSchema.parse({
      windowHours: 24, org: { capUsd: null, spentUsd: 0, warnPct: 0.8, state: 'ok' },
      projects: [], generatedAt: 0,
    }).org.state).toBe('ok')
  })
})
