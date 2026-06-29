/**
 * S6 — Bible freshness boundary (LOCK / gating).
 *
 * Locks the EXACT 30-day boundary semantics of the two pure freshness helpers
 * the bible/health surface depends on (verify.ts). The window is INCLUSIVE at
 * 30 days: 29 and 30 are fresh, 31 is stale. null freshness (no bible commits /
 * git failed) and a missing bible both count as NOT fresh. These functions are
 * pure (no DB, no fs, no git) so the tests are deterministic.
 *
 * Findings: S6-013 (boundary), testing/findings/S6-voice-bible.md.
 */
import { describe, it, expect } from 'vitest'
import { auditBible, bibleFreshFromDays } from '../src/verify.js'

describe('S6 bible freshness — bibleFreshFromDays (boundary inclusive at 30)', () => {
  it('29 days → fresh', () => {
    expect(bibleFreshFromDays(29, true)).toBe(true)
  })

  it('30 days → fresh (boundary is inclusive)', () => {
    expect(bibleFreshFromDays(30, true)).toBe(true)
  })

  it('31 days → stale', () => {
    expect(bibleFreshFromDays(31, true)).toBe(false)
  })

  it('0 days (just committed) → fresh', () => {
    expect(bibleFreshFromDays(0, true)).toBe(true)
  })

  it('null freshness (no bible commits / git unavailable) → NOT fresh', () => {
    expect(bibleFreshFromDays(null, true)).toBe(false)
  })

  it('no bible dir → NOT fresh even when freshnessDays would be fresh', () => {
    expect(bibleFreshFromDays(0, false)).toBe(false)
    expect(bibleFreshFromDays(null, false)).toBe(false)
  })
})

describe('S6 bible freshness — auditBible (matching boundary + finding shapes)', () => {
  it('29 days → no finding (fresh)', () => {
    expect(auditBible(29, true)).toEqual([])
  })

  it('30 days → no finding (boundary inclusive, still fresh)', () => {
    expect(auditBible(30, true)).toEqual([])
  })

  it('31 days → a single "stale" warn finding', () => {
    const f = auditBible(31, true)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warn')
    expect(f[0].area).toBe('bible')
    expect(f[0].message).toContain('bible stale: 31 days')
  })

  it('null freshness → a single "freshness unknown" warn finding', () => {
    const f = auditBible(null, true)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warn')
    expect(f[0].message).toContain('freshness unknown')
  })

  it('no bible dir → a single critical finding (regardless of freshnessDays)', () => {
    const f = auditBible(0, false)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].message).toContain('no project bible')
  })
})
