import { type ReactNode } from 'react'
import { cn } from '../lib/cn'

export function SectionHeader({ label, count, action, as: As = 'span', className }: {
  label: string; count?: number; action?: ReactNode; as?: 'h2' | 'h3' | 'span'; className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2 mb-2', className)}>
      <As className="micro-label">{label}</As>
      {count !== undefined && (
        <span className="mono text-micro text-muted bg-[var(--glass-1)] rounded-pill px-1.5 py-0.5">{count}</span>
      )}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}
