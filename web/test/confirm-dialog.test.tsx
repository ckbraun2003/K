/**
 * ConfirmDialog — focus behavior (wave C1 a11y): the confirm button auto-focuses
 * on open, and the useFocusTrap wiring wraps Tab at the boundaries (DOM order is
 * Cancel then Confirm, so Confirm is the LAST focusable and Cancel the FIRST):
 *   - Tab on Confirm (last) wraps forward to Cancel (first)
 *   - Shift+Tab on Cancel (first) wraps back to Confirm (last)
 * The trap only intercepts at the wrap boundaries — interior tabbing stays native.
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

  it('Tab on the last focusable (confirm) wraps to the first (cancel)', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    const cancel = screen.getByTestId('cd-cancel')
    await waitFor(() => expect(document.activeElement).toBe(confirm))

    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })

  it('Shift+Tab on the first focusable (cancel) wraps to the last (confirm)', async () => {
    renderDialog()
    const confirm = screen.getByTestId('cd-confirm')
    const cancel = screen.getByTestId('cd-cancel')
    await waitFor(() => expect(document.activeElement).toBe(confirm))

    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })
})
