import { describe, it, expect } from 'vitest'
import { parseFrontmatter, splitFrontmatter, roadmapPhases } from '../src/bible-parse.js'

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

describe('splitFrontmatter — LOSSLESS frontmatter preservation (bible section save)', () => {
  // The core data-integrity contract: rewriting an edited BODY back to disk as
  // `frontmatter + newBody` must never mangle the section's frontmatter. These lock
  // the `frontmatter + body === raw` identity that guarantees it.
  it('1. a normal section round-trips exactly (frontmatter + body === raw)', () => {
    const raw = '---\ntitle: "Vision"\nicon: "◈"\nstatus: stable\nupdated: 2026-01-01\n---\n\noriginal vision body\n'
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter + body).toBe(raw)
    expect(frontmatter).toBe('---\ntitle: "Vision"\nicon: "◈"\nstatus: stable\nupdated: 2026-01-01\n---\n')
    expect(body).toBe('\noriginal vision body\n')
    // body is byte-identical to parseFrontmatter's body (the two must agree, since
    // the editor lists via parseFrontmatter and saves via splitFrontmatter).
    expect(body).toBe(parseFrontmatter(raw).body)
  })

  it('2. no frontmatter → empty frontmatter, whole input preserved as body', () => {
    const raw = 'just markdown, no frontmatter\n'
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter).toBe('')
    expect(body).toBe(raw)
    expect(frontmatter + body).toBe(raw)
  })

  it('3. CRLF line endings are preserved (no corruption)', () => {
    const raw = '---\r\ntitle: X\r\nstatus: draft\r\n---\r\nbody line 1\r\nbody line 2\r\n'
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter + body).toBe(raw)
    expect(frontmatter).toBe('---\r\ntitle: X\r\nstatus: draft\r\n---\r\n')
    expect(body).toContain('\r\n') // CRLF intact in the body
    expect(body).toBe(parseFrontmatter(raw).body)
  })

  it('4. a body containing --- (HR / YAML-looking lines) is NOT truncated: anchors on the FIRST closing delimiter only', () => {
    const raw =
      '---\ntitle: T\n---\n' +
      'intro paragraph\n\n' +
      '---\n\n' +               // a markdown horizontal rule INSIDE the body
      'after the rule\n\n' +
      '---\nkey: value\n---\n' + // a YAML-looking block INSIDE the body
      'tail\n'
    const { frontmatter, body } = splitFrontmatter(raw)
    // Only the real frontmatter is peeled off; every embedded --- stays in the body.
    expect(frontmatter).toBe('---\ntitle: T\n---\n')
    expect(frontmatter + body).toBe(raw)
    expect(body).toContain('intro paragraph')
    expect(body).toContain('after the rule')
    expect(body).toContain('key: value')
    expect(body).toContain('tail')
    expect(body).toBe(parseFrontmatter(raw).body)
  })

  it('5. empty body → frontmatter kept, body empty, identity holds', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\n'
    const { frontmatter, body } = splitFrontmatter(raw)
    expect(frontmatter).toBe(raw)
    expect(body).toBe('')
    expect(frontmatter + body).toBe(raw)
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
