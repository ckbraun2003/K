/**
 * P4 fix(p4-seams) M2 / flag F1 — a legacy-hash redirect must REPLACE the current history
 * entry, not push a new one. Pushing lets Back return to the legacy hash, which re-redirects
 * → a forward-bounce trap. Renders the real useHashRoute in jsdom (.tsx ⇒ jsdom env) and spies
 * on history.replaceState: pre-fix `navigate` used `location.hash =` (a push), so replaceState
 * would never fire.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHashRoute } from '../src/lib/route'

afterEach(() => {
  window.location.hash = ''
  vi.restoreAllMocks()
})

describe('useHashRoute legacy-hash redirect (M2/F1)', () => {
  it('redirects #/chief → org/tree by REPLACING history (no push, no Back-trap)', () => {
    window.location.hash = '#/chief'
    const replaceSpy = vi.spyOn(window.history, 'replaceState')

    const { result } = renderHook(() => useHashRoute())

    // The rendered route is the canonical destination…
    expect(result.current).toEqual({ view: 'org', param: 'tree' })
    // …reached via replaceState (not a push), and the address bar is rewritten.
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '#/org/tree')
    expect(window.location.hash).toBe('#/org/tree')
  })

  it('a canonical hash does NOT redirect (no replaceState)', () => {
    window.location.hash = '#/projects'
    const replaceSpy = vi.spyOn(window.history, 'replaceState')

    const { result } = renderHook(() => useHashRoute())

    expect(result.current).toEqual({ view: 'projects', param: undefined, subParam: undefined })
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/projects')
  })
})
