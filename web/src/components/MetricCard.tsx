import { useEffect, useRef, useState } from 'react'
import Sparkline from './Sparkline'
import { cn } from '../lib/cn'

interface Props {
  label: string
  value: string
  spark?: number[]
  accent?: boolean
  /** Semantic emphasis tone. 'accent' (default when accent=true) is the pink brand
   *  tint; 'positive' is a green "healthy" tint — used for good-is-high metrics like a
   *  high success rate (green/amber/red carry status meaning, bible §8 dashboard UX). */
  tone?: 'accent' | 'positive'
}

/** Animates numeric text changes by interpolating the leading number. */
function useTicker(target: string): string {
  const [display, setDisplay] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const from = parseFloat(prev.current.replace(/[^\d.]/g, ''))
    const to = parseFloat(target.replace(/[^\d.]/g, ''))
    prev.current = target
    if (isNaN(from) || isNaN(to) || from === to) { setDisplay(target); return }
    const start = performance.now()
    let raf = 0
    const step = (t: number) => {
      const p = Math.min((t - start) / 400, 1)
      const eased = 1 - (1 - p) ** 3
      const current = from + (to - from) * eased
      setDisplay(target.replace(/[\d.,]+/, current.toFixed(to % 1 ? 2 : 0)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return display
}

export default function MetricCard({ label, value, spark, accent, tone = 'accent' }: Props) {
  const display = useTicker(value)
  const positive = accent && tone === 'positive'
  const pink = accent && tone === 'accent'
  // M-3: the sparkline must read the SAME tone as the headline number — it
  // previously always defaulted to the brand accent color regardless of
  // `tone`, so e.g. a green "positive" card's number was green but its
  // sparkline squiggle stayed pink.
  const sparkStroke = positive ? 'var(--green)' : pink ? 'var(--accent-hover)' : 'var(--muted)'
  return (
    <div
      className={cn(
        'card-lift min-w-[150px] flex-1 rounded-panel border px-5 py-4',
        // Non-blur tints only: this card renders inside glass widget cells, so it
        // must never use the .glass-panel/.glass-chrome tier CLASSES (those would
        // nest backdrop-filter — T25 I-1). The neutral branch below uses the flat
        // --glass-2 var (a plain opacity tint, no filter), which is safe here.
        pink && 'bg-accent/10 border-accent/25',
        positive && 'border-green/[0.28] bg-green/[0.08]',
        !accent && 'border-[var(--glass-tier-border)] bg-[var(--glass-2)]',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span
          className={cn(
            'mono text-2xl font-semibold',
            pink && 'text-accent-hover',
            positive && 'text-green',
            !accent && 'text-text',
          )}
        >
          {display}
        </span>
        {spark && <Sparkline values={spark} stroke={sparkStroke} />}
      </div>
    </div>
  )
}
