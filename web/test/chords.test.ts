import { describe, it, expect } from 'vitest'
import { CHORDS, CHORD_MAP } from '../src/lib/chords'
import { DESTINATIONS } from '../src/shell/Sidebar'
import { KNOWN_VIEWS, resolveRoute, parseHash } from '../src/lib/route'

describe('keyboard chords', () => {
  it('covers every enabled, routable Sidebar destination', () => {
    // `help` is an enabled destination but only deep-links into docs (no own
    // route/view), so it isn't a chord target. Every other enabled destination
    // with a real view must have a chord (finding #24 parity gap).
    const enabledViews = DESTINATIONS
      .filter(d => d.enabled && d.id !== 'help' && d.section !== 'hidden')
      .map(d => d.view ?? d.id)
    const chordViews = new Set(CHORDS.map(c => c.view))
    for (const v of enabledViews) {
      expect(chordViews.has(v), `missing chord for "${v}"`).toBe(true)
    }
  })

  it('has unique chord keys (no two chords share a second key)', () => {
    const keys = CHORDS.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('CHORD_MAP matches CHORDS', () => {
    for (const c of CHORDS) expect(CHORD_MAP[c.key]).toBe(c.view)
    expect(Object.keys(CHORD_MAP).length).toBe(CHORDS.length)
  })

  it('does not collide with single-key palette/legend handlers', () => {
    // The chord prefix is `g`; `?` opens the legend, `Escape` closes it, and
    // ⌘K/Ctrl+K opens the palette. None of these may appear as a chord key.
    const keys = new Set(CHORDS.map(c => c.key))
    for (const reserved of ['?', 'Escape']) expect(keys.has(reserved)).toBe(false)
  })

  it('the Workflows chord folds into Runs (workflows is now a redirect, not a standalone view)', () => {
    // P4 W0a: 'workflows' is no longer a standalone KNOWN_VIEW — it folds into Runs. The g-w
    // chord target still resolves correctly via VIEW_REDIRECTS; W0c (Task 3) rewrites the chord
    // config to the 9-item rail. This asserts the fold + redirect, not a stale known-view.
    expect(CHORD_MAP['w']).toBe('workflows')
    expect(KNOWN_VIEWS.has('workflows')).toBe(false)
    expect(resolveRoute(parseHash('#/workflows')).view).toBe('runs')
  })
})
