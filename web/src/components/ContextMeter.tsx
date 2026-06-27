import { cn } from '../lib/cn'
import type { ContextPressure, ContextBand } from '../lib/context'

/**
 * Compact inline context-pressure indicator for the run header meta row (Wave
 * D6). Shows the latest turn's input context size against the model's context
 * window (`ctx 142k / 200k · 71%`) plus a thin band-colored bar. When the
 * model's window is unknown (local / unrecognized model) it degrades to a muted
 * `ctx —` with an explanatory tooltip and no bar. Never crashes on an undefined
 * limit/percent.
 */

/** Compact token count: `142k` for ≥1000, the integer otherwise. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  return `${Math.round(n / 1000)}k`
}

const BAND_BAR: Record<ContextBand, string> = {
  ok: 'bg-[var(--green)]',
  warn: 'bg-[var(--amber)]',
  danger: 'bg-[var(--red)]',
  unknown: 'bg-[var(--muted)]',
}

export default function ContextMeter({ pressure }: { pressure: ContextPressure }) {
  const { tokens, limit, percent, band } = pressure

  // Unknown window → muted dash, no bar, explanatory tooltip.
  if (band === 'unknown' || limit == null || percent == null) {
    return (
      <span
        data-testid="context-meter"
        role="img"
        aria-label="Context usage unknown"
        title="Context window unknown for this model — pressure can't be shown."
        className="inline-flex items-center gap-1 text-[var(--muted)]"
      >
        ctx —
      </span>
    )
  }

  const pct = Math.round(percent)
  return (
    <span
      data-testid="context-meter"
      role="img"
      aria-label={`Context usage ${pct}% (${tokens} of ${limit} tokens)`}
      title={`${tokens.toLocaleString()} / ${limit.toLocaleString()} context tokens`}
      className="inline-flex items-center gap-1.5 text-[var(--muted)]"
    >
      <span className="whitespace-nowrap">
        ctx {formatTokens(tokens)} / {formatTokens(limit)} · {pct}%
      </span>
      <span
        aria-hidden
        className="h-1 w-12 overflow-hidden rounded-full bg-[var(--border)]"
      >
        <span
          data-testid="context-meter-fill"
          className={cn('block h-full rounded-full transition-[width] duration-300', BAND_BAR[band])}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  )
}
