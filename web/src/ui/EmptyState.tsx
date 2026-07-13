import { type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Icon, type IconName } from './Icon'

export function EmptyState({ icon, headline, hint, action, tier = 'panel', className }: {
  icon: IconName; headline: string; hint?: string; action?: ReactNode
  /** FU-2: 'solid' swaps the icon bubble's glass-panel for the non-blur
   *  surface-solid tier — for use inside a cell that's already a GlassPanel
   *  ancestor, where a nested glass-panel would stack backdrop-filter inside
   *  backdrop-filter. */
  tier?: 'panel' | 'solid'
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12 text-center', className)}>
      <div className={cn(tier === 'solid' ? 'surface-solid' : 'glass-panel', 'rounded-pill p-3 text-muted')}>
        <Icon name={icon} size={20} />
      </div>
      <p className="text-body font-medium">{headline}</p>
      {hint && <p className="text-caption text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
