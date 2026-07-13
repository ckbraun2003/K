// core/test/cron-util.test.ts
import { describe, it, expect } from 'vitest'
import { isValidCron, nextRunAt, nlToCron } from '../src/cron-util.js'

describe('cron-util', () => {
  it('validates cron expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
  })
  it('computes the next fire time (09:00 daily) after a known instant', () => {
    const from = Date.parse('2026-07-12T08:00:00Z')
    const next = nextRunAt('0 9 * * *', from)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(from)
    // within the next 24h
    expect(next! - from).toBeLessThanOrEqual(24 * 3600_000)
  })
  it('nlToCron returns a validated cron, or an error for an untranslatable phrase', async () => {
    expect(await nlToCron('every day at 9am', async () => '0 9 * * *')).toEqual({ cron: '0 9 * * *' })
    expect(await nlToCron('gibberish', async () => 'still not cron')).toEqual({ error: expect.stringMatching(/cron/i) })
  })
})
