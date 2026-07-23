import { type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Icon, type IconName } from './Icon'
import { Button } from './Button'

export function EmptyState({ icon, headline, hint, action, cta, illustration, tier = 'panel', className }: {
  icon: IconName; headline: string; hint?: string
  /** Bespoke ReactNode slot (legacy callers) — renders after the CTA. */
  action?: ReactNode
  /** FE-4 #2 — the ONE primary call-to-action (frozen contract shape). */
  cta?: { label: string; onClick(): void }
  /** FE-4 #2 — replaces the icon bubble with a custom (reduced-motion-safe)
   *  illustration; the icon bubble is skipped entirely when set. */
  illustration?: ReactNode
  /** FU-2, retuned Round 3 (D-134): 'solid' swaps the icon bubble's glass-panel
   *  for the `.glass-icon` pinkish-purple chip — the one saturated-purple role
   *  in the color-by-role hierarchy (work-item/note icons). Originally the
   *  non-blur surface-solid tier (for a cell already nested inside a
   *  GlassPanel ancestor); glass-icon has no backdrop-filter either, so the
   *  nesting rationale still holds. */
  tier?: 'panel' | 'solid'
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12 text-center', className)}>
      {illustration ?? (
        <div className={cn(tier === 'solid' ? 'glass-icon' : 'glass-panel text-muted', 'rounded-pill p-3')}>
          <Icon name={icon} size={20} />
        </div>
      )}
      <p className="text-body font-medium">{headline}</p>
      {hint && <p className="text-caption text-muted">{hint}</p>}
      {cta && (
        <Button variant="primary" size="sm" className="mt-2" onClick={cta.onClick}>
          {cta.label}
        </Button>
      )}
      {action && <div className={cta ? 'mt-1' : 'mt-2'}>{action}</div>}
    </div>
  )
}
