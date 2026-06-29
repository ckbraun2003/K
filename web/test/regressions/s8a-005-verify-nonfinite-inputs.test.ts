/**
 * CONFIRMED FAULT — finding S8-005 (see testing/findings/S8-web-ui.md).
 *
 * Surface: web/src/lib/verify.ts :: barPct, relativeTime, formatTimeAgo.
 *
 * These helpers feed UI widths and human-readable labels but do not guard
 * non-finite numeric inputs, so garbage reaches the DOM:
 *
 *   - barPct: docstring promises "Clamped so a malformed/over-max value can never
 *     blow past a full bar", but `Math.max(0, Math.min(1, NaN))` is `NaN`, so a
 *     NaN value (or NaN max) escapes the clamp and yields a `width: NaN%` style.
 *     (Infinity -> 1 and -Infinity -> 0 DO clamp correctly; only NaN escapes.)
 *   - relativeTime / formatTimeAgo: a non-finite `ts` propagates straight through
 *     the arithmetic into the template string -> "NaNd ago" / "Infinityd ago" /
 *     "verified NaNd ago".
 *
 * Expected: non-finite numeric inputs degrade to a safe value (a clamped finite
 * fraction for barPct; a neutral label for the time helpers). RED until guarded.
 *
 * prober: PROBER-A · validator: VALIDATOR-A
 */
import { describe, it, expect } from 'vitest'
import { barPct, relativeTime, formatTimeAgo } from '../../src/lib/verify'

describe('S8-005 — verify.ts must defend non-finite numeric inputs', () => {
  it('barPct clamps a NaN value to a finite [0,1] fraction', () => {
    const r = barPct(NaN, 40)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(1)
  })

  it('barPct clamps a NaN max to a finite [0,1] fraction', () => {
    const r = barPct(20, NaN)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(1)
  })

  it('relativeTime does not emit a NaN/Infinity label for a non-finite ts', () => {
    expect(relativeTime(NaN)).not.toMatch(/NaN|Infinity/)
    expect(relativeTime(-Infinity)).not.toMatch(/NaN|Infinity/)
  })

  it('formatTimeAgo does not emit a NaN/Infinity label for a non-finite ts', () => {
    expect(formatTimeAgo(NaN)).not.toMatch(/NaN|Infinity/)
  })
})
