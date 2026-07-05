import { cn } from '../lib/cn'

/**
 * Segmented single-select control — extracted verbatim from the identical
 * private copies in MetricsPage/RoutingPage (wave C1) so new surfaces (the
 * capability catalog's facet filters) reuse ONE implementation. Each segment
 * exposes aria-pressed reflecting the selection (F-006 a11y lock).
 */
export default function SegControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--raised)] p-0.5 gap-0.5">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors duration-150',
            value === opt.value
              ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
