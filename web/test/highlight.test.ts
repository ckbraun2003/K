/**
 * Task 12 Step 2 — lazy refractor grammar loading behind DiffViewer v2's
 * per-line syntax highlighting. Unknown/unregistered languages pass through
 * as plain strings (zero-regression fallback).
 */
import { describe, it, expect } from 'vitest'
import { langForPath, ensureLangs, highlightLine } from '../src/lib/highlight'

describe('highlight', () => {
  it('maps extensions to grammar ids (12 languages + null fallback)', () => {
    expect(langForPath('a/b.tsx')).toBe('tsx')
    expect(langForPath('x.py')).toBe('python')
    expect(langForPath('m.rs')).toBe('rust')
    expect(langForPath('Makefile')).toBeNull()
  })
  it('highlights a registered language into styled spans and passes unknown through', async () => {
    await ensureLangs(['typescript'])
    const nodes = highlightLine('const a = 1', 'typescript')
    expect(Array.isArray(nodes)).toBe(true)
    expect(highlightLine('const a = 1', null)).toBe('const a = 1') // plain string passthrough
  })
})
