import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function EmptyState({ icon, headline, hint, action }: {
  icon: IconName; headline: string; hint?: string; action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="glass-panel rounded-pill p-3 text-muted"><Icon name={icon} size={20} /></div>
      <p className="text-body font-medium">{headline}</p>
      {hint && <p className="text-caption text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
