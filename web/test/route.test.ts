import { describe, it, expect } from 'vitest'
import { parseHash, isKnownView } from '../src/lib/route'

describe('parseHash', () => {
  it('parses a plain view hash', () => {
    expect(parseHash('#/metrics')).toEqual({ view: 'metrics', param: undefined, subParam: undefined })
  })

  it('empty / bare hash → home', () => {
    expect(parseHash('').view).toBe('home')
    expect(parseHash('#').view).toBe('home')
    expect(parseHash('#/').view).toBe('home')
  })

  it('parses view/param/subParam', () => {
    expect(parseHash('#/project/abc/tasks')).toEqual({ view: 'project', param: 'abc', subParam: 'tasks' })
  })

  it('strips a query suffix in the hash so #/projects?query is not a 404 (F-083)', () => {
    const r = parseHash('#/projects?foo=bar')
    expect(r.view).toBe('projects')          // NOT 'projects?foo=bar'
    expect(isKnownView(r.view)).toBe(true)   // resolves to the real view, not NotFound
  })

  it('strips a query suffix while preserving param/subParam', () => {
    expect(parseHash('#/project/abc?tab=graph')).toEqual({ view: 'project', param: 'abc', subParam: undefined })
    expect(parseHash('#/project/abc/tasks?x=1')).toEqual({ view: 'project', param: 'abc', subParam: 'tasks' })
  })

  it('an unknown view is still unknown (NotFound), query or not', () => {
    expect(isKnownView(parseHash('#/nonsense').view)).toBe(false)
    expect(isKnownView(parseHash('#/nonsense?x=1').view)).toBe(false)
  })
})
