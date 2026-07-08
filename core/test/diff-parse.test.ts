/** P1 A1 — unified-diff parser: one parser normalizes git diff AND gh pr diff. */
import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../src/diff-parse.js'

const MODIFY = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ ctx header',
  ' line one',
  '-old two',
  '+new two',
  ' line three',
].join('\n')

const ADD_DELETE_RENAME_BINARY = [
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1,1 @@',
  '+hello',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
  'diff --git a/old-name.ts b/new-name.ts',
  'similarity index 96%',
  'rename from old-name.ts',
  'rename to new-name.ts',
  'diff --git a/pic.png b/pic.png',
  'index 111..222 100644',
  'Binary files a/pic.png and b/pic.png differ',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses a modification with line numbers on both sides', () => {
    const { files, truncated } = parseUnifiedDiff(MODIFY)
    expect(truncated).toBe(false)
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, binary: false })
    expect(f.hunks[0].header).toBe('@@ -1,3 +1,3 @@ ctx header')
    expect(f.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'line one', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'old two', oldLine: 2, newLine: null },
      { kind: 'add', text: 'new two', oldLine: null, newLine: 2 },
      { kind: 'ctx', text: 'line three', oldLine: 3, newLine: 3 },
    ])
  })

  it('classifies added / deleted / renamed / binary', () => {
    const { files } = parseUnifiedDiff(ADD_DELETE_RENAME_BINARY)
    expect(files.map(f => f.status)).toEqual(['added', 'deleted', 'renamed', 'modified'])
    expect(files[0].hunks[0].lines[0]).toEqual({ kind: 'add', text: 'hello', oldLine: null, newLine: 1 })
    expect(files[2]).toMatchObject({ path: 'new-name.ts', oldPath: 'old-name.ts' })
    expect(files[3].binary).toBe(true)
  })

  it('handles quoted paths with spaces', () => {
    const { files } = parseUnifiedDiff('diff --git "a/has space.txt" "b/has space.txt"\n@@ -1 +1 @@\n-a\n+b')
    expect(files[0].path).toBe('has space.txt')
  })

  it('truncates at the byte cap on a file boundary', () => {
    const one = MODIFY + '\n'
    const big = one.repeat(Math.ceil((5 * 1024 * 1024) / one.length) + 10)
    const { files, truncated } = parseUnifiedDiff(big)
    expect(truncated).toBe(true)
    expect(files.length).toBeGreaterThan(0)
  })

  it('empty input → no files', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [], truncated: false })
  })

  it('strips trailing \\r from CRLF-terminated content lines (quality-review fix)', () => {
    const { files } = parseUnifiedDiff('diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1,1 +1,1 @@\n-old\r\n+new\r\n')
    expect(files[0].hunks[0].lines).toEqual([
      { kind: 'del', text: 'old', oldLine: 1, newLine: null },
      { kind: 'add', text: 'new', oldLine: null, newLine: 1 },
    ])
  })
})
