/**
 * The ONE canonical segmented single-select (F-006 a11y lock; originally extracted verbatim
 * from Metrics/Routing). P4 E-30: extended in place — optional `ariaLabel` (a11y group name),
 * `size`, and per-option optional `icon`/`count`. Existing callers
 * ({ options:{label,value}[], value, onChange }) are unchanged.
 */
export interface SegOption<T extends string> { label: string; value: T; icon?: string; count?: number }

export default function SegControl<T extends string>({
  options, value, onChange, ariaLabel, size = 'md',
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
}) {
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            data-testid={`seg-${o.value}`}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded ${pad} font-medium transition-colors ${
              active ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {o.icon && <span aria-hidden>{o.icon}</span>}
            <span>{o.label}</span>
            {o.count != null && <span className="rounded-full bg-[var(--surface)] px-1 text-[10px]">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
