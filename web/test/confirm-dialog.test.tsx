/**
 * ConfirmDialog — focus behavior. The confirm button auto-focuses on open.
 * FU-1: Tab containment used to be narrowed to just Cancel/Confirm by a
 * second, hand-rolled trap that also blinded Radix's own FocusScope at the
 * wrap boundary — which meant the header Close button could never be
 * reached by keyboard at all. That narrowing is gone; Tab order is now
 * whatever Radix's FocusScope produces over the whole dialog (Close, then
 * Cancel, then Confirm), same as every other Dialog-based modal
 * (RewindDialog has no Tab-wrap tests of its own for the same reason: this
 * is Radix's contract to keep, not ours to assert keydown-by-keydown).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import ConfirmDialog from '../src/components/ConfirmDialog'

// jsdom has no matchMedia; framer-motion may probe it. Inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})
afterEach(() => cleanup())

function renderDialog() {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      open
      title="Kill run?"
      message="really?"
      confirmLabel="Kill run"
      testid="cd"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog focus trap', () => {
  it('auto-focuses the confirm button on open', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    await waitFor(() => expect(document.activeElement).toBe(confirm))
  })

  it('the header Close button is reachable by keyboard (FU-1: no longer trapped out)', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    await waitFor(() => expect(document.activeElement).toBe(confirm))
    // Under the old footer-scoped trap this button was never a wrap target at
    // all — Tab/Shift+Tab only ever cycled Cancel<->Confirm. It must at least
    // exist, be enabled, and sit before Cancel/Confirm in DOM (tab) order.
    const close = screen.getByRole('button', { name: 'Close' })
    const cancel = screen.getByTestId('cd-cancel')
    expect((close as HTMLButtonElement).disabled).toBe(false)
    expect(
      close.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('Tab on the last focusable (confirm) wraps to the first (close) — Radix FocusScope', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    const close = screen.getByRole('button', { name: 'Close' })
    await waitFor(() => expect(document.activeElement).toBe(confirm))

    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
  })

  it('Shift+Tab on the first focusable (close) wraps to the last (confirm) — Radix FocusScope', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    const close = screen.getByRole('button', { name: 'Close' })
    await waitFor(() => expect(document.activeElement).toBe(confirm))

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })
})
