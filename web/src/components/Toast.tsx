import { useEffect, useLayoutEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../ui/Icon'

interface Props {
  open: boolean
  message: React.ReactNode
  /** Optional action (e.g. a "view run" link). */
  action?: { label: string; onClick: () => void; testid?: string }
  testid?: string
  /** Optional leading icon + tint — success (green check) or warning (amber
   *  triangle). Omitted (default) renders the plain untinted toast. */
  kind?: 'success' | 'warning'
  /** Auto-dismiss after this many ms (default 6000). */
  durationMs?: number
  /** Restart the auto-dismiss countdown when this changes while open. Callers that
   *  REPLACE the toast's subject without closing it (e.g. a second ask-K send
   *  swapping the pending-undo run) pass the subject's id here — the new run must
   *  get a fresh full window, not inherit the first run's dying timer. */
  resetKey?: string | number
  onDismiss: () => void
}

/**
 * Lightweight bottom-right toast. Auto-dismisses and supports a single action
 * link (used to jump to a triggered run). fixed inset-0 is reserved for blocking
 * overlays; a toast is non-blocking so it pins to a corner with `fixed … z-50`.
 */
export default function Toast({ open, message, action, testid, kind, durationMs = 6000, resetKey, onDismiss }: Props) {
  // Hold the latest onDismiss in a ref so an inline-arrow caller re-rendering
  // (e.g. live WS run patches) doesn't restart the auto-dismiss countdown.
  const onDismissRef = useRef(onDismiss)
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss
  })
  // `resetKey` is a deliberate dep: a changed key while open clears the running
  // timer and starts a fresh full-duration countdown (see the prop doc above).
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => onDismissRef.current(), durationMs)
    return () => clearTimeout(t)
  }, [open, durationMs, resetKey])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid={testid}
          role="status"
          aria-live="polite"
          // ui-adjustments Round 2 (D-133): graded-glass, not opaque — .glass-panel's
          // tier fill is opacity-tint only (no backdrop-filter), so this no longer
          // risks a nested blur on the one call site (NotificationBell's notif-toast)
          // that's a DOM descendant of TopBar's glass-chrome header. rounded-panel is
          // just the radius token, independent of the glass tiers.
          className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-panel border border-[var(--glass-tier-border)] bg-[var(--glass-3)] px-4 py-3 shadow-lg"
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        >
          {kind && (
            <Icon
              name={kind === 'success' ? 'check' : 'warning'}
              size={14}
              className={kind === 'success' ? 'shrink-0 text-green' : 'shrink-0 text-amber'}
              label={kind}
            />
          )}
          <div className="text-xs text-text">{message}</div>
          {action && (
            <button
              onClick={() => { action.onClick(); onDismiss() }}
              data-testid={action.testid}
              className="flex-shrink-0 rounded-control border border-[var(--glass-tier-border)] px-2.5 py-1 text-xs font-semibold text-accent-hover transition-colors hover:bg-[var(--glass-active)] hover:border-accent"
            >
              {action.label}
            </button>
          )}
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="flex-shrink-0 rounded-control p-0.5 text-muted transition-colors hover:bg-[var(--glass-active)] hover:text-text"
          >
            <Icon name="close" size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
