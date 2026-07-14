import { cn } from '../lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('shimmer', className)} />
}
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex items-center gap-3 py-2', className)}>
      <div className="shimmer size-4 rounded-pill" />
      <div className="shimmer h-3.5 flex-1 max-w-64" />
      <div className="shimmer h-3 w-16 ml-auto" />
    </div>
  )
}
export function SkeletonTile({ className, tier = 'panel' }: {
  className?: string
  /** FU-2: 'solid' swaps glass-panel for the non-blur surface-solid tier — for
   *  use inside a cell that's already a GlassPanel ancestor, where a nested
   *  glass-panel would stack backdrop-filter inside backdrop-filter. */
  tier?: 'panel' | 'solid'
}) {
  return (
    <div aria-hidden="true" className={cn(tier === 'solid' ? 'surface-solid' : 'glass-panel', 'p-4 space-y-3', className)}>
      <div className="shimmer h-3 w-24" />
      <div className="shimmer h-7 w-32" />
      <div className="shimmer h-3 w-full" />
    </div>
  )
}
