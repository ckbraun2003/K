import { cn } from '../lib/cn'

export function Spinner({ size = 16, className }: { size?: 14 | 16 | 20; className?: string }) {
  return (
    <svg role="status" aria-label="Loading" width={size} height={size} viewBox="0 0 16 16"
      className={cn('animate-spin text-muted', className)} fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
