import { type ReactNode } from 'react'
import { cn } from '../lib/cn'

export function SectionHeader({ label, count, action, className }: {
  label: string; count?: number; action?: ReactNode; className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2 mb-2', className)}>
      <span className="micro-label">{label}</span>
      {count !== undefined && (
        <span className="mono text-micro text-muted bg-raised rounded-pill px-1.5 py-0.5">{count}</span>
      )}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}
