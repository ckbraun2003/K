import { describe, it, expect } from 'vitest'
import { CHORDS, CHORD_MAP } from '../src/lib/chords'
import { KNOWN_VIEWS } from '../src/lib/route'

describe('keyboard chords', () => {
  it('pins the Task 10 remap — one chord per primary/hidden-but-chorded view', () => {
    expect(CHORDS).toEqual([
      { key: 'h', view: 'home', label: 'Home' },
      { key: 'u', view: 'personal', label: 'Personal' },
      { key: 'a', view: 'agents', label: 'Agents' },
      { key: 'r', view: 'runs', label: 'Runs' },
      { key: 'n', view: 'insights', label: 'Insights' },
      { key: 'p', view: 'projects', label: 'Projects' },
      { key: 'd', view: 'docs', label: 'Docs' },
      { key: ',', view: 'settings', label: 'Settings' },
    ])
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
    // ⌘K/Ctrl+K now focuses the MessageDock. None of these may appear as a chord key.
    const keys = new Set(CHORDS.map(c => c.key))
    for (const reserved of ['?', 'Escape']) expect(keys.has(reserved)).toBe(false)
  })

  it('every chord targets a KNOWN_VIEW (Task 10 restores the full cross-check)', () => {
    // Task 6's route table is the final 13-member IA; every chord here must resolve
    // to one of those views — no chord may dangle on a pre-restructure name.
    for (const c of CHORDS) expect(KNOWN_VIEWS.has(c.view), `"${c.view}" is not a KNOWN_VIEW`).toBe(true)
  })

  it('no chord survives for a removed/folded pre-restructure view', () => {
    const chordViews = new Set(CHORDS.map(c => c.view))
    for (const gone of ['org', 'skills', 'inbox', 'lessons', 'chief', 'orchestrators', 'graph',
      'metrics', 'routing', 'evals', 'workflows', 'workflow-detail', 'memory', 'terminal'])
      expect(chordViews.has(gone)).toBe(false)
  })
})
