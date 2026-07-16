import { cn } from '../lib/cn'
import { GlassPanel } from './GlassPanel'
import Sparkline from '../components/Sparkline'

export function KpiTile({ label, value, delta, spark, period, tier = 'panel', className }: {
  label: string; value: string
  delta?: { pct: number; polarity: 'goodUp' | 'badUp' }
  /** Optional per-period series for a trend sparkline. Absent or all-zero renders
   *  no svg at all — a flat line would fabricate a trend that isn't there. */
  spark?: number[]
  /** Micro-label for the tile's measurement window, e.g. "14D". */
  period?: string
  tier?: 'panel' | 'solid'
  className?: string
}) {
  const up = delta ? delta.pct >= 0 : false
  const good = delta ? (delta.polarity === 'goodUp') === up : false
  // M-1: a flat 0% delta is neither good nor bad — coloring it red/green (and
  // signing it +) falsely implies movement that didn't happen.
  const flat = delta ? delta.pct === 0 : false
  return (
    <GlassPanel tier={tier} className={cn('p-4 glass-interactive', className)}>
      {period && <span className="micro-label float-right opacity-70">{period}</span>}
      <div className="micro-label">{label}</div>
      <div className="mono text-display mt-1">{value}</div>
      {delta && (
        <span className={cn('mono text-caption', flat ? 'text-muted' : good ? 'text-green' : 'text-red')}>
          {!flat && up ? '+' : ''}{delta.pct}%
        </span>
      )}
      {spark && spark.some(v => v > 0) && (
        <div className="mt-1.5" aria-hidden>
          <Sparkline values={spark} width={96} height={20} stroke="var(--accent)" />
        </div>
      )}
    </GlassPanel>
  )
}
