// Keyboard `g`-chord navigation map + the in-app shortcut legend.
// Single source of truth so Shell's keydown handler and the `?` legend overlay
// can't drift (finding #24: only 5 of 9 enabled views had chords, and there was
// no discoverable list). Every ENABLED Sidebar destination gets a chord here.

export interface Chord {
  /** Second key pressed after the `g` prefix. */
  key: string
  /** Route view id to navigate to. */
  view: string
  /** Label shown in the legend. */
  label: string
}

// Mnemonics chosen to avoid colliding with each other. Every 6-rail primary
// destination plus Settings has a chord (UI Simplification Task 10); Docs is
// hidden from the rail but still deep-linkable via `g d`.
export const CHORDS: Chord[] = [
  { key: 'h', view: 'home', label: 'Home' },
  { key: 'u', view: 'personal', label: 'Personal' },
  { key: 'a', view: 'agents', label: 'Agents' },
  { key: 'r', view: 'runs', label: 'Runs' },
  { key: 'n', view: 'insights', label: 'Insights' },
  { key: 'p', view: 'projects', label: 'Projects' },
  { key: 'd', view: 'docs', label: 'Docs' },
  { key: ',', view: 'settings', label: 'Settings' },
]

/** key → view lookup for the keydown handler. */
export const CHORD_MAP: Record<string, string> = Object.fromEntries(
  CHORDS.map(c => [c.key, c.view]),
)
