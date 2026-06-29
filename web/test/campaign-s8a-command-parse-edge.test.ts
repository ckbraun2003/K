import { describe, it, expect } from 'vitest'
import { parseProjectQuery } from '../src/lib/command-parse'
import type { Project } from '@k/shared'

/**
 * S8a LOCK — palette query parsing on adversarial input.
 *
 * Pins NEW edge behaviors the existing command-parse suite does not cover:
 * newline handling around the dispatch body, and that matching is pure string
 * work (project names containing regex-special characters can never cause a
 * ReDoS or a throw). All degrade defensibly — none throw.
 */

function makeProject(name: string): Project {
  return {
    id: `00000000-0000-0000-0000-${name.replace(/[^0-9a-f]/gi, '0').padStart(12, '0').slice(-12)}`,
    name,
    localPath: `/projects/${name}`,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: 0,
  }
}

const k = makeProject('k')

describe('S8a — parseProjectQuery newline handling', () => {
  it('a newline INSIDE the dispatch body degrades to an (empty) completion, never throws', () => {
    // `(.+)$` has no `s` flag, so it cannot cross the newline; the dispatch regex
    // fails and the query falls back to completion mode (multi-line bodies aren't
    // supported by the palette). Must not throw.
    let result!: ReturnType<typeof parseProjectQuery>
    expect(() => { result = parseProjectQuery('@k fix\nmore lines', [k]) }).not.toThrow()
    expect(result.type).toBe('completion')
    if (result.type === 'completion') expect(result.matches).toEqual([])
  })

  it('a newline as the @name/body SEPARATOR still dispatches with the trailing body', () => {
    const result = parseProjectQuery('@k\nfix the thing', [k])
    expect(result.type).toBe('dispatch')
    if (result.type === 'dispatch') {
      expect(result.project.name).toBe('k')
      expect(result.rest).toBe('fix the thing')
    }
  })
})

describe('S8a — project names with regex-special characters are matched literally', () => {
  const dotPlus = makeProject('a.b+c')
  const star = makeProject('x*y')

  it('an exact dispatch matches a regex-special name as a plain string', () => {
    const result = parseProjectQuery('@a.b+c deploy now', [dotPlus, star])
    expect(result.type).toBe('dispatch')
    if (result.type === 'dispatch') {
      expect(result.project.name).toBe('a.b+c')
      expect(result.rest).toBe('deploy now')
    }
  })

  it('completion prefix uses startsWith, so `.`/`*` are literal, not wildcards', () => {
    // `@a.` must match only 'a.b+c', NOT every project (which a regex `.` would).
    const result = parseProjectQuery('@a.', [dotPlus, star])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches.map(p => p.name)).toEqual(['a.b+c'])
    }
  })

  it('a very long query is handled in linear time without throwing (no ReDoS)', () => {
    const long = '@' + 'z'.repeat(100_000) + ' ' + 'w'.repeat(100_000)
    const start = performance.now()
    const result = parseProjectQuery(long, [k])
    expect(performance.now() - start).toBeLessThan(500)
    // unknown long name with a body -> ambiguous (no match), never throws
    expect(result.type).toBe('ambiguous')
  })
})
