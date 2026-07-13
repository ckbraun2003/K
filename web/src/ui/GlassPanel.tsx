import { type ElementType, type ComponentPropsWithoutRef } from 'react'
import { cn } from '../lib/cn'

const TIER = {
  panel: 'glass-panel', chrome: 'glass-chrome',
  overlay: 'glass-overlay', solid: 'surface-solid',
} as const

export function GlassPanel<T extends ElementType = 'div'>({
  tier = 'panel', interactive, as, className, ...rest
}: { tier?: keyof typeof TIER; interactive?: boolean; as?: T } & ComponentPropsWithoutRef<T>) {
  const C = (as ?? 'div') as ElementType
  return <C className={cn(TIER[tier], interactive && 'card-lift cursor-pointer', className)} {...rest} />
}
