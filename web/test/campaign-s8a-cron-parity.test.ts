import { describe, it, expect } from 'vitest'
import { checkCron } from '../src/lib/cron'

/**
 * S8a LOCK — node-cron v4 parity quirks + the illegal-character guard.
 *
 * The client validator must accept exactly what the server's node-cron accepts.
 * These pin NEW adversarial cases the existing cron suite does not cover. They
 * are the COMPLEMENT to the confirmed range-expansion DoS (regressions/s8a-003):
 * the cheap, defensible rejections/acceptances that must keep working.
 */

describe('S8a — cron name + range parity', () => {
  it('accepts a weekday NAME range (MON-FRI)', () => {
    expect(checkCron('0 0 * * MON-FRI').valid).toBe(true)
  })

  it('accepts a reversed numeric range (node-cron swaps 5-1 to 1-5)', () => {
    expect(checkCron('5-1 * * * *').valid).toBe(true)
  })

  it('accepts weekday 70 as Sunday (non-global 7->0 quirk leaves a valid 0)', () => {
    // node-cron maps the first `7` to `0`: "70" -> "00" -> 0 (Sunday). Faithful
    // port behavior, pinned so a future "fix" to global-replace is a deliberate choice.
    expect(checkCron('* * * * 70').valid).toBe(true)
  })
})

describe('S8a — cron defensible rejections', () => {
  it('rejects a list with an empty token (1,,2) without throwing', () => {
    const r = checkCron('1,,2 * * * *')
    expect(r.valid).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('the illegal-character guard rejects control + unicode chars (never reaching range expansion)', () => {
    const tab = '0 0 * * *\t' // horizontal tab
    const newline = '0 0 * * *\n5' // embedded newline
    const control = '0 0 * * ' + String.fromCharCode(1) // SOH control char (not whitespace)
    const unicode = '0 0 * * caf' + String.fromCharCode(0xe9) // e-acute -> non-ASCII
    for (const bad of [tab, newline, control, unicode]) {
      const r = checkCron(bad)
      expect(r.valid, JSON.stringify(bad)).toBe(false)
      expect(r.error, JSON.stringify(bad)).toContain('illegal characters')
    }
  })

  it('rejects a non-string / empty pattern with a required-field hint', () => {
    expect(checkCron('' as string).valid).toBe(false)
    expect(checkCron(undefined as unknown as string).valid).toBe(false)
    expect(checkCron(undefined as unknown as string).error).toBeTruthy()
  })
})
