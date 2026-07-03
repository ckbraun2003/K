/**
 * useFocusTrap — container-boundary regression (wave C1 quality review).
 *
 * Dialogs that open by focusing the CONTAINER itself (tabIndex={-1} — the evals
 * RunDialog pattern) start with document.activeElement === the container, which is
 * neither the first nor the last focusable. The trap must treat that state as a
 * backward boundary: Shift+Tab wraps to the LAST focusable instead of falling
 * through to the browser and walking focus OUT of the modal. (Forward Tab from the
 * container needs no intercept — the browser naturally enters the first interior
 * focusable.) Also pins that disabled inputs are excluded from the boundary query.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from '../src/lib/useFocusTrap'

function TrapFixture({ disableLast = false }: { disableLast?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, true)
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap-container">
      <button data-testid="trap-first">first</button>
      <button data-testid="trap-middle">middle</button>
      {/* an INPUT as the last element pins the selector's disabled-input exclusion
          (disabled buttons were always excluded; inputs/selects/textareas were not) */}
      <input data-testid="trap-last" disabled={disableLast} />
    </div>
  )
}

afterEach(() => cleanup())

describe('useFocusTrap container boundary', () => {
  it('Shift+Tab while the container itself holds focus wraps to the last focusable', () => {
    render(<TrapFixture />)
    const container = screen.getByTestId('trap-container')
    container.focus()
    expect(document.activeElement).toBe(container)

    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('trap-last'))
  })

  it('a disabled element is not a boundary — the wrap lands on the last ENABLED focusable', () => {
    render(<TrapFixture disableLast />)
    const container = screen.getByTestId('trap-container')
    container.focus()

    fireEvent.keyDown(container, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByTestId('trap-middle'))
  })
})
