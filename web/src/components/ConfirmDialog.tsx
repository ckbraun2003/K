import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useFocusTrap } from '../lib/useFocusTrap'

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
  const footerRef = useRef<HTMLDivElement | null>(null)

  // Dialog's content is Radix-portaled, and the Portal itself defers actually
  // mounting into the DOM by one render pass (it starts `mounted=false` and
  // flips true via its own effect) — so on the render where `open` first
  // becomes true, `footerRef.current` is still null. useFocusTrap's effect
  // only ever runs once per `active` transition (its deps are [ref, active]),
  // so if it ran while the ref was still null it would never attach at all.
  // Gate `active` on the footer actually being in the DOM so the hook's
  // effect fires (for the first time) only once that's guaranteed true.
  const [footerMounted, setFooterMounted] = useState(false)
  const footerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    footerRef.current = node
    // Reset on detach (dialog close unmounts the Radix-portaled footer while
    // this component instance persists across ~15 call sites toggling `open`)
    // so the next open cycle re-arms the trap: the ref attaches -> this flips
    // true -> useFocusTrap's effect (deps [ref, active]) re-runs with a live
    // node. Without this reset, `open && footerMounted` would already be true
    // the instant `open` flips on reopen — one render before Radix remounts
    // the footer — so the effect would fire once against a null ref and never
    // retry.
    setFooterMounted(node !== null)
  }, [])

  // a11y: keep Tab/Shift+Tab cycling between the footer's own two controls
  // (Cancel/Confirm) — scoped narrower than Dialog's built-in trap (which also
  // cycles through the header's Close button) to match the house two-button
  // convention. A raw `addEventListener` on the footer fires during native
  // event bubbling before React's synthetic dispatch reaches Radix's own
  // FocusScope handler higher up, so this wins at the wrap boundaries without
  // fighting Radix.
  useFocusTrap(footerRef, open && footerMounted)

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
        // Radix's own FocusScope wraps the whole dialog (header+body+footer)
        // trapped, with its own Tab handler — after useFocusTrap's raw
        // listener above has already wrapped focus within the footer's two
        // buttons, that same Tab keydown still reaches Radix's handler via
        // React's synthetic dispatch (native propagation isn't stopped by a
        // plain addEventListener). Against the full-dialog tabbable edges
        // (Close is first, Confirm is last) it can re-process the same key
        // and fight the footer-scoped trap. Stop it here at the boundary —
        // but only while useFocusTrap is actually armed (`footerMounted`);
        // otherwise this would blind Radix's own containment on a render
        // where the footer-scoped trap isn't attached to anything.
        <div
          ref={footerCallbackRef}
          className="contents"
          onKeyDown={e => { if (e.key === 'Tab' && footerMounted) e.stopPropagation() }}
        >
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
        </div>
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
