import { type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * One interactive list row (impressive-wave FE-4 systemic #3) — the shared
 * skin for Runs rows, project Runs, Personal Chats, CI rows, Recent Activity.
 * Hover elevation + reveal-on-hover actions + right-aligned meta slots.
 * Glass-LOOK by design (ui-adjustments C3, D-131): a semi-transparent tinted
 * background (--glass-2 resting; --glass-active blue interaction wash on
 * hover/selected, ui-adjustments Round 2 D-133) with NO backdrop-filter —
 * dense lists never sit on real blur (DEV-11 budget), so the row reads as
 * glass without a blur cost.
 */
export function Row({
  title, sub, leading, meta, actions, selected, onClick, className, testid,
}: {
  title: ReactNode
  /** Muted second line under the title. */
  sub?: ReactNode
  /** Leading slot — StatusPill / Icon / severity dot. */
  leading?: ReactNode
  /** Right-aligned mono meta slot — timestamps, cost, duration. */
  meta?: ReactNode
  /** Reveal-on-hover actions (IconButtons); also revealed by keyboard focus. */
  actions?: ReactNode
  selected?: boolean
  onClick?: () => void
  className?: string
  testid?: string
}) {
  const interactive = onClick != null
  function onKeyDown(e: KeyboardEvent) {
    if (!interactive) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!() }
  }
  return (
    <div
      data-testid={testid}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left',
        'bg-[var(--glass-2)] transition-colors duration-[var(--dur-1)]',
        interactive && 'cursor-pointer hover:bg-[var(--glass-active)] focus-visible:glow-focus',
        selected && 'bg-[var(--glass-active)] border-l-2 border-l-accent',
        className,
      )}
    >
      {leading && <span className="flex-shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-text">{title}</span>
        {sub && <span className="block truncate text-caption text-muted">{sub}</span>}
      </span>
      {meta && <span className="mono flex-shrink-0 text-label tabular-nums text-muted">{meta}</span>}
      {actions && (
        <span className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-[var(--dur-1)] focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </span>
      )}
    </div>
  )
}
