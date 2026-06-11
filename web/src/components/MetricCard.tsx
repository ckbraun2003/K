import { useEffect, useRef, useState } from 'react'
import Sparkline from './Sparkline'

interface Props {
  label: string
  value: string
  spark?: number[]
  accent?: boolean
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

export default function MetricCard({ label, value, spark, accent }: Props) {
  const display = useTicker(value)
  return (
    <div className="card-lift flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</span>
      <div className="mt-0.5 flex items-end justify-between gap-2">
        <span className={`mono text-xl font-semibold ${accent ? 'text-[var(--accent-hover)]' : 'text-[var(--text)]'}`}>{display}</span>
        {spark && <Sparkline values={spark} />}
      </div>
    </div>
  )
}
