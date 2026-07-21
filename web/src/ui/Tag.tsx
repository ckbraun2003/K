import { type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Icon } from './Icon'

const TINT = {
  neutral: 'bg-[var(--glass-2)] text-muted border-[var(--glass-tier-border)]',
  accent: 'bg-accent/15 text-accent border-accent/25',
  sky: 'bg-accent-hover/15 text-accent-hover border-accent-hover/25',
} as const

export function Tag({ tint = 'neutral', onDismiss, className, children }: {
  tint?: keyof typeof TINT; onDismiss?: () => void; className?: string; children: ReactNode
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-label', TINT[tint], className)}>
      {children}
      {onDismiss && (
        <button type="button" aria-label="remove" onClick={onDismiss} className="rounded-pill hover:bg-[var(--glass-active)] hover:text-text">
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  )
}
