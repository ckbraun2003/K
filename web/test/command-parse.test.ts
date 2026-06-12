import { describe, it, expect } from 'vitest'
import { parseProjectQuery } from '../src/lib/command-parse'
import type { Project } from '@k/shared'

function makeProject(name: string): Project {
  return {
    id: `00000000-0000-0000-0000-${name.padStart(12, '0')}`,
    name,
    localPath: `/projects/${name}`,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: 0,
  }
}

const k = makeProject('k')
const k2 = makeProject('k2')
const ku = makeProject('ku')
const alpha = makeProject('alpha')
const beta = makeProject('beta')

describe('parseProjectQuery', () => {
  it('non-@ query returns none', () => {
    expect(parseProjectQuery('fix the bug', [k, k2])).toEqual({ type: 'none' })
    expect(parseProjectQuery('', [k])).toEqual({ type: 'none' })
    expect(parseProjectQuery('hello world', [k])).toEqual({ type: 'none' })
  })

  it('bare @ returns completion listing all projects', () => {
    const result = parseProjectQuery('@', [k, k2, alpha])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches).toEqual([k, k2, alpha])
    }
  })

  it('@partial with unique prefix match returns completion with one match', () => {
    const result = parseProjectQuery('@al', [k, k2, alpha, beta])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].name).toBe('alpha')
    }
  })

  it('@partial with multiple prefix matches returns completion with filtered matches', () => {
    const result = parseProjectQuery('@k', [k, k2, ku, alpha])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches.map(p => p.name)).toEqual(['k', 'k2', 'ku'])
    }
  })

  it('@name rest — exact match wins over longer prefix candidates (k vs k2)', () => {
    // 'k' is exact, 'k2' starts with 'k' too — exact wins
    const result = parseProjectQuery('@k fix the thing', [k, k2])
    expect(result.type).toBe('dispatch')
    if (result.type === 'dispatch') {
      expect(result.project.name).toBe('k')
      expect(result.rest).toBe('fix the thing')
    }
  })

  it('unique prefix dispatch (@ku fix with one match)', () => {
    const result = parseProjectQuery('@ku fix bug', [k, k2, ku])
    expect(result.type).toBe('dispatch')
    if (result.type === 'dispatch') {
      expect(result.project.name).toBe('ku')
      expect(result.rest).toBe('fix bug')
    }
  })

  it('ambiguous prefix with rest returns ambiguous', () => {
    // both 'k' and 'k2' start with 'k', but there is no exact match for 'k' here
    const result = parseProjectQuery('@k fix bug', [k2, ku])
    expect(result.type).toBe('ambiguous')
    if (result.type === 'ambiguous') {
      expect(result.prefix).toBe('k')
    }
  })

  it('unknown name with rest returns ambiguous', () => {
    const result = parseProjectQuery('@zzz do something', [k, alpha])
    expect(result.type).toBe('ambiguous')
  })

  it('case-insensitive matching', () => {
    const result = parseProjectQuery('@ALPHA fix', [k, alpha])
    expect(result.type).toBe('dispatch')
    if (result.type === 'dispatch') {
      expect(result.project.name).toBe('alpha')
      expect(result.rest).toBe('fix')
    }
  })

  it('case-insensitive completion prefix', () => {
    const result = parseProjectQuery('@AL', [k, alpha, beta])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches.map(p => p.name)).toEqual(['alpha'])
    }
  })

  it('zero projects — bare @ returns empty completion', () => {
    const result = parseProjectQuery('@', [])
    expect(result.type).toBe('completion')
    if (result.type === 'completion') {
      expect(result.matches).toHaveLength(0)
    }
  })

  it('zero projects — @name rest returns ambiguous', () => {
    const result = parseProjectQuery('@k fix', [])
    expect(result.type).toBe('ambiguous')
  })
})
