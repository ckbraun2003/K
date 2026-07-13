import { cn } from '../lib/cn'
import { GlassPanel } from './GlassPanel'

export function KpiTile({ label, value, delta, tier = 'panel', className }: {
  label: string; value: string
  delta?: { pct: number; polarity: 'goodUp' | 'badUp' }
  tier?: 'panel' | 'solid'
  className?: string
}) {
  const up = delta ? delta.pct >= 0 : false
  const good = delta ? (delta.polarity === 'goodUp') === up : false
  // M-1: a flat 0% delta is neither good nor bad — coloring it red/green (and
  // signing it +) falsely implies movement that didn't happen.
  const flat = delta ? delta.pct === 0 : false
  return (
    <GlassPanel tier={tier} className={cn('p-4', className)}>
      <div className="micro-label">{label}</div>
      <div className="mono text-display mt-1">{value}</div>
      {delta && (
        <span className={cn('mono text-caption', flat ? 'text-muted' : good ? 'text-green' : 'text-red')}>
          {!flat && up ? '+' : ''}{delta.pct}%
        </span>
      )}
    </GlassPanel>
  )
}
