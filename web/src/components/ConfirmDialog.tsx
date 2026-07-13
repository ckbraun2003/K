import { useEffect, useRef } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

interface Props {
  open: boolean
  title: string
  /** Body text — e.g. the name of the thing being destroyed. */
  message: React.ReactNode
  /** Label for the destructive confirm button. */
  confirmLabel: string
  /** Optional testid prefix; the confirm button is `${testid}-confirm`, cancel `${testid}-cancel`. */
  testid?: string
  busy?: boolean
  /** Optional error to surface above the buttons (e.g. a failed confirm action). */
  error?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Destructive-action confirm modal, built on the shared Radix `<Dialog>` +
 * `<Button variant="danger">` primitives. Enter confirms, Escape cancels —
 * consistent with the ⌘K confirm card.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  testid,
  busy,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // FU-1: Tab containment is left entirely to Radix's own FocusScope (which
  // wraps the whole dialog — Close, then Cancel, then Confirm), matching
  // RewindDialog and every other Dialog-based modal. This used to narrow the
  // trap to just Cancel/Confirm via a second, hand-rolled useFocusTrap plus a
  // stopPropagation hack to blind Radix's own handler at the boundary — which
  // had the side effect of making the header Close button unreachable by
  // keyboard (Tab could never land on it at all), a real a11y regression
  // relative to every other dialog in the app.

  // Focus the confirm button on open and wire a global Enter so keyboard
  // handling matches the other dialogs even when focus is elsewhere. Radix's
  // FocusScope sets its container via a ref-callback-triggered state update,
  // so its own mount auto-focus (which lands on the header Close button, the
  // first tabbable element) runs in a *cascading* render/effect pass — it is
  // not reliably ordered against a plain parent `useEffect`. Deferring via
  // rAF guarantees this runs after that settles, so it always wins.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => confirmRef.current?.focus())
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter') { e.preventDefault(); if (!busy) onConfirm() }
    }
    window.addEventListener('keydown', onKey)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey) }
  }, [open, busy, onConfirm])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onCancel() }}
      title={title}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            data-testid={testid ? `${testid}-cancel` : undefined}
          >
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            data-testid={testid ? `${testid}-confirm` : undefined}
          >
            {busy ? '…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div data-testid={testid}>
        {message}
        {error && (
          <p data-testid={testid ? `${testid}-error` : undefined} className="mt-3 text-caption text-red">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
