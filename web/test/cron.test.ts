import { describe, it, expect } from 'vitest'
import { checkCron, isValidCron } from '../src/lib/cron'

// The client validator is a faithful port of node-cron v4's `validate`
// (convertExpression + validateDetailed). node-cron is a core-only dep, so we
// can't import it here; instead these cases were verified against node-cron's
// actual source semantics (5/6 fields, per-field bounds, names, ranges, lists,
// illegal-char guard) — the comment on each case documents node-cron's verdict.
void isValidCron

describe('checkCron', () => {
  const valid = [
    '0 2 * * *',          // 2am daily (5-field)
    '* * * * *',          // every minute
    '*/5 * * * *',        // every 5 min
    '0 0 1 1 *',          // new year
    '0 9-17 * * 1-5',     // business hours weekdays
    '0 0 * * mon',        // weekday name
    '0 0 1 jan *',        // month name
    '30 0 2 * * *',       // 6-field (seconds)
    '0,15,30,45 * * * *', // comma list
    '0 2 * * * * *',      // 7 fields — node-cron validates only the first 6 and
                          // IGNORES trailing fields, so the server ACCEPTS this.
    '* * * * * * *',      // 7 fields of `*` — same: server-accepts.
  ]
  const invalid = [
    '',                   // empty
    '   ',                // blank
    '0 2 * *',            // 4 fields (fewer than 5 core fields)
    '99 * * * *',         // minute out of range
    '* 25 * * *',         // hour out of range
    '* * 32 * *',         // day out of range
    '* * * 13 *',         // month out of range
    '* * * * 8',          // weekday out of range (0-7 ok, 8 not)
    'not a cron',         // garbage with illegal char? "not a cron" -> letters allowed but invalid fields
    '@daily',             // illegal char @
  ]

  it('accepts valid expressions', () => {
    for (const e of valid) expect(checkCron(e).valid, e).toBe(true)
  })

  it('rejects invalid expressions with a hint', () => {
    for (const e of invalid) {
      const r = checkCron(e)
      expect(r.valid, e).toBe(false)
      expect(r.error, e).toBeTruthy()
    }
  })

  it('isValidCron agrees with checkCron.valid', () => {
    for (const e of [...valid, ...invalid]) {
      expect(isValidCron(e), e).toBe(checkCron(e).valid)
    }
  })

  it('does not reject the weekday-7 alias (Sunday)', () => {
    // node-cron maps 7→0, so `0 0 * * 7` is valid Sunday — must not be flagged.
    expect(checkCron('0 0 * * 7').valid).toBe(true)
  })

  it('tolerates a 6-field expression with a trailing field (server parity)', () => {
    // node-cron v4 `validate` only checks the first 6 fields and ignores the
    // rest, so a 6-field core + 1 trailing must NOT be rejected on count.
    expect(checkCron('30 0 2 * * * 5').valid).toBe(true)
  })
})
