import { Icon } from './Icon'
import { Button } from './Button'

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="bg-[var(--glass-2)] border border-red/30 rounded-control flex items-center gap-3 px-4 py-3">
      <Icon name="warning" size={16} className="text-red" />
      <p className="text-body text-red flex-1">{message}</p>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  )
}
