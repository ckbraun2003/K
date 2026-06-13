import { describe, it, expect } from 'vitest'
import { parseFrontmatter, roadmapPhases } from '../src/bible-parse.js'

describe('parseFrontmatter', () => {
  it('parses keys and strips quotes', () => {
    const { meta, body } = parseFrontmatter('---\ntitle: Vision\nicon: "◈"\nstatus: stable\n---\nHello')
    expect(meta.title).toBe('Vision')
    expect(meta.icon).toBe('◈')
    expect(body).toBe('Hello')
  })

  it('handles CRLF line endings', () => {
    const { meta, body } = parseFrontmatter('---\r\ntitle: X\r\n---\r\nbody')
    expect(meta.title).toBe('X')
    expect(body).toBe('body')
  })

  it('returns raw body when no frontmatter', () => {
    const { meta, body } = parseFrontmatter('just markdown')
    expect(meta).toEqual({})
    expect(body).toBe('just markdown')
  })
})

describe('roadmapPhases', () => {
  it('counts checkboxes per ## heading', () => {
    const md = '## Phase 0\n- [x] a\n- [ ] b\n## Phase 1\n- [x] c\n- [x] d\n- [ ] e\n'
    expect(roadmapPhases(md)).toEqual([
      { name: 'Phase 0', done: 1, total: 2 },
      { name: 'Phase 1', done: 2, total: 3 },
    ])
  })

  it('skips headings without checkboxes and strips markdown emphasis', () => {
    const md = '## Notes\nprose only\n## Phase 0 — Foundation *(current)*\n- [X] done\n'
    expect(roadmapPhases(md)).toEqual([{ name: 'Phase 0 — Foundation (current)', done: 1, total: 1 }])
  })
})
