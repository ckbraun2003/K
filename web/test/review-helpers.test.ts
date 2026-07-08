/** P1 A3 — pure diff-render helpers (node env — no jsdom). */
import { describe, it, expect } from 'vitest'
import { alignHunk, groupByDir, commentAnchorKey } from '../src/lib/review'
import type { DiffFile, DiffHunk } from '@k/shared'

const HUNK: DiffHunk = {
  header: '@@ -1,3 +1,3 @@',
  lines: [
    { kind: 'ctx', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'del', text: 'b1', oldLine: 2, newLine: null },
    { kind: 'del', text: 'b2', oldLine: 3, newLine: null },
    { kind: 'add', text: 'c1', oldLine: null, newLine: 2 },
    { kind: 'ctx', text: 'd', oldLine: 4, newLine: 3 },
  ],
}

describe('alignHunk', () => {
  it('pairs del/add runs side-by-side; ctx spans both', () => {
    const rows = alignHunk(HUNK)
    expect(rows).toEqual([
      { left: HUNK.lines[0], right: HUNK.lines[0] },
      { left: HUNK.lines[1], right: HUNK.lines[3] },   // b1 | c1
      { left: HUNK.lines[2], right: null },            // b2 | —
      { left: HUNK.lines[4], right: HUNK.lines[4] },
    ])
  })
})

describe('groupByDir', () => {
  it('groups by containing dir, sorted', () => {
    const f = (p: string): DiffFile => ({ path: p, oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] })
    const groups = groupByDir([f('src/b/x.ts'), f('src/a/y.ts'), f('root.md')])
    expect(groups.map(g => g.dir)).toEqual(['', 'src/a', 'src/b'])
  })
})

describe('commentAnchorKey', () => {
  it('is stable per (file,line,side)', () => {
    expect(commentAnchorKey('a.ts', 3, 'new')).toBe('a.ts:3:new')
    expect(commentAnchorKey('a.ts', null, 'new')).toBe('a.ts:file:new')
  })
})
