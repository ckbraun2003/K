import { useEffect, useLayoutEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface Props {
  open: boolean
  message: React.ReactNode
  /** Optional action (e.g. a "view run" link). */
  action?: { label: string; onClick: () => void; testid?: string }
  testid?: string
  /** Auto-dismiss after this many ms (default 6000). */
  durationMs?: number
  onDismiss: () => void
}

/**
 * Lightweight bottom-right toast. Auto-dismisses and supports a single action
 * link (used to jump to a triggered run). fixed inset-0 is reserved for blocking
 * overlays; a toast is non-blocking so it pins to a corner with `fixed … z-50`.
 */
export default function Toast({ open, message, action, testid, durationMs = 6000, onDismiss }: Props) {
  // Hold the latest onDismiss in a ref so an inline-arrow caller re-rendering
  // (e.g. live WS run patches) doesn't restart the auto-dismiss countdown.
  const onDismissRef = useRef(onDismiss)
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss
  })
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => onDismissRef.current(), durationMs)
    return () => clearTimeout(t)
  }, [open, durationMs])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid={testid}
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-lg"
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        >
          <div className="text-xs text-[var(--text)]">{message}</div>
          {action && (
            <button
              onClick={() => { action.onClick(); onDismiss() }}
              data-testid={action.testid}
              className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[var(--accent)]"
            >
              {action.label}
            </button>
          )}
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="flex-shrink-0 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            ✕
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
