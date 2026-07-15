/**
 * Task 12 Step 2 — word-level intra-line diff (client LCS on word/whitespace
 * tokens), behind DiffViewer v2's per-pair changed-span rendering.
 */
import { describe, it, expect } from 'vitest'
import { intralineDiff } from '../src/lib/review'

describe('intralineDiff', () => {
  it('marks only the changed word-level spans', () => {
    const r = intralineDiff('  return a + b', '  return a + b + 0')!
    expect(r.old.every(s => !s.changed)).toBe(true)
    expect(r.new.filter(s => s.changed).map(s => s.text).join('')).toBe(' + 0')
    expect(r.new.map(s => s.text).join('')).toBe('  return a + b + 0')
  })
  it('marks replacements on both sides', () => {
    const r = intralineDiff('const x = old()', 'const x = brandNew()')!
    expect(r.old.filter(s => s.changed).map(s => s.text).join('')).toContain('old')
    expect(r.new.filter(s => s.changed).map(s => s.text).join('')).toContain('brandNew')
  })
  it('bails (null) past the per-line cap — no quadratic blowup', () => {
    expect(intralineDiff('a'.repeat(401), 'b', 400)).toBeNull()
    expect(intralineDiff('a', 'b'.repeat(401), 400)).toBeNull()
  })
})
