// core/test/cron-util.test.ts
import { describe, it, expect } from 'vitest'
import { isValidCron, nextRunAt, nlToCron } from '../src/cron-util.js'
import { translateNlToCron } from '../src/nl-cron-translate.js'

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

  // These are all crons node-cron's validate() accepts — before the fix nextRunAt
  // returned null for each (rendering "not scheduled" for a perfectly valid routine).
  const from = Date.parse('2026-07-12T08:00:00Z') // a Sunday, 08:00 UTC

  it('handles Sunday-as-7 in the day-of-week field (0 9 * * 7)', () => {
    const next = nextRunAt('0 9 * * 7', from)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(from)
    // Every fire must land on a Sunday at 09:00 local.
    const d = new Date(next!)
    expect(d.getDay()).toBe(0)
    expect(d.getHours()).toBe(9)
  })

  it('handles a 6-field (leading-seconds) expr (0 0 9 * * *)', () => {
    const next = nextRunAt('0 0 9 * * *', from)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(from)
    // Reduces to "0 9 * * *": 09:00 the same/next day.
    expect(new Date(next!).getHours()).toBe(9)
  })

  it('handles a named day-of-week alias (0 9 * * MON)', () => {
    const next = nextRunAt('0 9 * * MON', from)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(from)
    const d = new Date(next!)
    expect(d.getDay()).toBe(1) // Monday
    expect(d.getHours()).toBe(9)
  })

  it('fires on EITHER day-of-month OR day-of-week when both are restricted (0 9 1 * 1)', () => {
    const next = nextRunAt('0 9 1 * 1', from)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(from)
    // From Sun 2026-07-12, the OR semantics fire on the NEXT Monday (2026-07-13)
    // — much sooner than the 1st of a month. AND semantics (the bug) would instead
    // demand "the 1st AND a Monday", skipping many months.
    const d = new Date(next!)
    expect(d.getHours()).toBe(9)
    // must be either the 1st of the month OR a Monday (never require both)
    expect(d.getDate() === 1 || d.getDay() === 1).toBe(true)
    // proves it did NOT wait for a rare "Monday the 1st": within ~2 days here.
    expect(next! - from).toBeLessThanOrEqual(3 * 24 * 3600_000)
  })

  it('nlToCron returns a validated cron, or an error for an untranslatable phrase', async () => {
    expect(await nlToCron('every day at 9am', async () => '0 9 * * *')).toEqual({ cron: '0 9 * * *' })
    expect(await nlToCron('gibberish', async () => 'still not cron')).toEqual({ error: expect.stringMatching(/cron/i) })
  })
})

describe('nl-cron hour bound', () => {
  it('rejects an out-of-range clock hour instead of emitting a wrong cron', async () => {
    // "at 25am" would slip through %12 → "0 1 * * *" (a valid-but-wrong cron); the
    // bound check returns '' so nlToCron rejects it and the route 400s.
    expect(await translateNlToCron('at 25am')).toBe('')
    expect(await translateNlToCron('at 13pm')).toBe('')
    expect(await translateNlToCron('at 0am')).toBe('')
    // in-range still translates correctly (12am → 0, 12pm → 12, 9am → 9)
    expect(await translateNlToCron('at 9am')).toBe('0 9 * * *')
    expect(await translateNlToCron('at 12am')).toBe('0 0 * * *')
    expect(await translateNlToCron('at 12pm')).toBe('0 12 * * *')
  })
})
