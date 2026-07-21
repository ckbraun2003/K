/**
 * The ONE canonical segmented single-select (F-006 a11y lock; originally extracted verbatim
 * from Metrics/Routing). P4 E-30: extended in place — optional `ariaLabel` (a11y group name),
 * `size`, and per-option optional `icon`/`count`. UI Simplification Task 12 review: optional
 * per-option `disabled` (not selectable, aria-disabled) and an optional `activeTone`
 * ('surface' default | 'accent' — accent fill uses `text-[var(--bg)]`, never text-white).
 * Both strictly additive: existing callers ({ options:{label,value}[], value, onChange })
 * and their rendered class output are unchanged.
 */
export interface SegOption<T extends string> { label: string; value: T; icon?: string; count?: number; disabled?: boolean }

export default function SegControl<T extends string>({
  options, value, onChange, ariaLabel, size = 'md', activeTone = 'surface',
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
  activeTone?: 'surface' | 'accent'
}) {
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
  const activeCls = activeTone === 'accent'
    ? 'bg-[var(--accent)] text-[var(--bg)] shadow-sm'
    : 'bg-[var(--glass-4)] text-[var(--text)] shadow-sm'
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-0.5 rounded-lg border border-[var(--glass-tier-border)] bg-[var(--glass-1)] p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            data-testid={`seg-${o.value}`}
            disabled={o.disabled}
            aria-disabled={o.disabled || undefined}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded ${pad} font-medium transition-colors ${
              active ? activeCls : 'text-[var(--muted)] hover:bg-[var(--glass-active)] hover:text-[var(--text)]'
            }${o.disabled ? ' cursor-not-allowed opacity-40' : ''}`}
          >
            {o.icon && <span aria-hidden>{o.icon}</span>}
            <span>{o.label}</span>
            {o.count != null && <span className="rounded-full bg-[var(--glass-1)] px-1 text-[10px]">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
