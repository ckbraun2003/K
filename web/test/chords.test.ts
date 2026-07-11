import { describe, it, expect } from 'vitest'
import { CHORDS, CHORD_MAP } from '../src/lib/chords'
import { DESTINATIONS } from '../src/shell/Sidebar'

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

  it('chords target the P4 9-item IA (merged/folded pre-P4 views have no chord)', () => {
    const chordViews = new Set(CHORDS.map(c => c.view))
    expect(chordViews.has('org')).toBe(true)
    expect(chordViews.has('insights')).toBe(true)
    for (const gone of ['chief', 'orchestrators', 'graph', 'metrics', 'routing', 'evals', 'workflows'])
      expect(chordViews.has(gone)).toBe(false)
    // NOTE: CHORDS/DESTINATIONS still point at the pre-restructure views ('org', 'skills',
    // 'inbox') and are intentionally untouched here — Task 10 (Shell swap) retargets them at
    // the new hubs. Until then they are outside KNOWN_VIEWS's 13-member set; no KNOWN_VIEWS
    // cross-check against CHORDS belongs in this file until that task lands.
  })
})
