import { useEffect, useRef, useState } from 'react'
import { navigate } from './route'
import { CHORD_MAP } from './chords'

export interface ShellKeyHandlers {
  /** Toggle the ⌘K command palette. */
  onToggleCommand: () => void
  /** Toggle the `?` shortcut legend. */
  onToggleLegend: () => void
  /** Close the shortcut legend (Escape). */
  onCloseLegend: () => void
}

/**
 * Global keyboard chrome for the Shell: the ⌘K palette, the `?`/Escape legend,
 * and the `g`-prefixed navigation chords. Returns whether a chord is currently
 * armed so the Shell can render a pending-chord affordance (F-009).
 *
 * Extracted from Shell so the chord state machine is unit-testable without
 * mounting the whole app. The key fix (F-001): once a `g` chord is armed, the
 * NEXT key RESOLVES it — even a second `g` (which post-P4 has no chord, so it
 * simply disarms). That branch MUST run before the arming branch, otherwise
 * `g g` re-arms the chord instead of resolving.
 */
export function useShellKeys({
  onToggleCommand,
  onToggleLegend,
  onCloseLegend,
}: ShellKeyHandlers): { chordArmed: boolean } {
  const [chordArmed, setChordArmed] = useState(false)
  // Latest callbacks held in a ref so the keydown listener stays stable (mounted
  // once, empty deps). Re-installing it mid-chord would reset the armed state and
  // drop a chord the operator is halfway through.
  const handlers = useRef<ShellKeyHandlers>({ onToggleCommand, onToggleLegend, onCloseLegend })
  handlers.current = { onToggleCommand, onToggleLegend, onCloseLegend }

  useEffect(() => {
    let chord = false
    let chordTimer: ReturnType<typeof setTimeout>
    const disarm = () => {
      chord = false
      clearTimeout(chordTimer)
      setChordArmed(false)
    }
    const arm = () => {
      chord = true
      setChordArmed(true)
      clearTimeout(chordTimer)
      chordTimer = setTimeout(() => {
        chord = false
        setChordArmed(false)
      }, 800)
    }
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        handlers.current.onToggleCommand()
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // `?` (Shift+/) toggles the shortcut legend. Clear any armed g-chord first so
      // the g→? quirk can't fire a stale chord after the legend closes.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        disarm()
        handlers.current.onToggleLegend()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        disarm()
        handlers.current.onCloseLegend()
        return
      }
      // A g-chord is already armed → the second key RESOLVES it (a second `g`
      // has no chord post-P4, so it just disarms). Must precede the arming branch (F-001).
      if (chord) {
        disarm()
        if (CHORD_MAP[e.key]) {
          e.preventDefault()
          navigate(CHORD_MAP[e.key])
        }
        return
      }
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        arm()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      clearTimeout(chordTimer)
      window.removeEventListener('keydown', handler)
    }
  }, [])

  return { chordArmed }
}
