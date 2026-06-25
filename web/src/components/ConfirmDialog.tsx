import { useEffect, useId, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

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
 * Destructive-action confirm modal. Matches the hybrid-glass overlay style used
 * by the project-register dialog (fixed inset-0 z-50, backdrop, spring card).
 * Enter confirms, Escape cancels — consistent with the ⌘K confirm card.
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
  const headingId = useId()

  // Focus the confirm button on open and wire global Enter/Escape so keyboard
  // handling matches the other dialogs even when focus is elsewhere.
  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      if (e.key === 'Enter') { e.preventDefault(); if (!busy) onConfirm() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onConfirm, onCancel])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={headingId}
            data-testid={testid}
            className="relative w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
            initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <h3 id={headingId} className="text-sm font-semibold text-[var(--text)]">{title}</h3>
            <div className="mt-1.5 text-xs text-[var(--muted)]">{message}</div>
            {error && (
              <p data-testid={testid ? `${testid}-error` : undefined} className="mt-3 text-xs text-red-400">
                {error}
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={onCancel}
                data-testid={testid ? `${testid}-cancel` : undefined}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                onClick={onConfirm}
                disabled={busy}
                data-testid={testid ? `${testid}-confirm` : undefined}
                className="rounded-lg bg-red/20 px-4 py-1.5 text-xs font-semibold text-[var(--red)] transition-colors hover:bg-red/30 disabled:opacity-50"
              >
                {busy ? '…' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
