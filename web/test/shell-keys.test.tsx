/**
 * useShellKeys — the Shell's global keyboard chrome (F-001 g-chord resolve fix +
 * F-009 pending-chord affordance). Rendered through a tiny harness that mirrors
 * how Shell consumes the hook (indicator + palette/legend callbacks), so both the
 * chord state machine AND the "renders an indicator" behavior are covered without
 * mounting the whole app. `navigate` is mocked to a spy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import { useShellKeys } from '../src/lib/use-shell-keys'

function Harness() {
  const [cmd, setCmd] = useState(0)
  const [legend, setLegend] = useState(false)
  const { chordArmed } = useShellKeys({
    onToggleCommand: () => setCmd(c => c + 1),
    onToggleLegend: () => setLegend(l => !l),
    onCloseLegend: () => setLegend(false),
  })
  return (
    <div>
      {chordArmed && <div data-testid="chord-pending">g…</div>}
      <span data-testid="cmd-count">{cmd}</span>
      <span data-testid="legend-open">{String(legend)}</span>
    </div>
  )
}

const key = (init: KeyboardEventInit) => fireEvent.keyDown(document.body, init)

beforeEach(() => mockNavigate.mockClear())
afterEach(() => cleanup())

describe('useShellKeys — g-chord', () => {
  it('g then g resolves (disarms) and does NOT re-arm — F-001', () => {
    render(<Harness />)
    key({ key: 'g' })
    expect(screen.getByTestId('chord-pending')).toBeTruthy() // armed
    key({ key: 'g' })
    // The armed branch runs BEFORE the arming branch, so a second `g` RESOLVES the
    // chord instead of re-arming it (the actual F-001 guard). Post-P4 the `g` key is
    // no longer a chord target (Fleet Graph folded into Org's graph segment), so it
    // clears WITHOUT navigating — the regression guarded here is the no-re-arm.
    expect(mockNavigate).not.toHaveBeenCalled()
    // resolved → no longer armed
    expect(screen.queryByTestId('chord-pending')).toBeNull()
  })

  it('g then p still navigates to Projects (other chords unbroken)', () => {
    render(<Harness />)
    key({ key: 'g' })
    key({ key: 'p' })
    expect(mockNavigate).toHaveBeenCalledWith('projects')
    expect(screen.queryByTestId('chord-pending')).toBeNull()
  })

  it('a non-chord second key clears the chord without navigating', () => {
    render(<Harness />)
    key({ key: 'g' })
    key({ key: 'z' }) // not a chord target
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('chord-pending')).toBeNull()
  })

  it('shows a pending indicator while armed and clears it on timeout — F-009', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<Harness />)
      act(() => { key({ key: 'g' }) })
      expect(screen.getByTestId('chord-pending')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(801) })
      expect(screen.queryByTestId('chord-pending')).toBeNull()
      expect(mockNavigate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useShellKeys — palette + legend', () => {
  it('⌘K toggles the command palette', () => {
    render(<Harness />)
    key({ key: 'k', metaKey: true })
    expect(screen.getByTestId('cmd-count').textContent).toBe('1')
  })

  it('? toggles the legend and clears any armed chord', () => {
    render(<Harness />)
    key({ key: 'g' })
    expect(screen.getByTestId('chord-pending')).toBeTruthy()
    key({ key: '?' })
    expect(screen.getByTestId('legend-open').textContent).toBe('true')
    // the ? cleared the armed chord, so a following key can't fire a stale chord
    expect(screen.queryByTestId('chord-pending')).toBeNull()
    key({ key: 'g' })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('ignores chords typed into an input/textarea', () => {
    render(
      <>
        <Harness />
        <input data-testid="field" />
      </>,
    )
    const field = screen.getByTestId('field')
    fireEvent.keyDown(field, { key: 'g' })
    fireEvent.keyDown(field, { key: 'g' })
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('chord-pending')).toBeNull()
  })
})
