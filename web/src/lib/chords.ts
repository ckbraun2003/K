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

// Mnemonics chosen to avoid colliding with each other. `g g` → Fleet Graph is
// intentional (the prefix key is also a valid target once the chord is armed).
export const CHORDS: Chord[] = [
  { key: 'h', view: 'home', label: 'K' },
  { key: 'i', view: 'inbox', label: 'Inbox' },
  { key: 'c', view: 'chief', label: 'Chief' },
  { key: 'o', view: 'orchestrators', label: 'Orchestrators' },
  { key: 'p', view: 'projects', label: 'Projects' },
  { key: 'g', view: 'graph', label: 'Fleet Graph' },
  { key: 'r', view: 'runs', label: 'Runs' },
  { key: 's', view: 'skills', label: 'Skills' },
  { key: 'm', view: 'metrics', label: 'Metrics' },
  { key: 'x', view: 'routing', label: 'Routing' },
  { key: 'e', view: 'evals', label: 'Evals' },
  { key: 'y', view: 'memory', label: 'Memory' },
  { key: 't', view: 'terminal', label: 'Terminal' },
  { key: 'w', view: 'workflows', label: 'Workflows' },
  { key: 'd', view: 'docs', label: 'Docs' },
  { key: ',', view: 'settings', label: 'Settings' },
]

/** key → view lookup for the keydown handler. */
export const CHORD_MAP: Record<string, string> = Object.fromEntries(
  CHORDS.map(c => [c.key, c.view]),
)
