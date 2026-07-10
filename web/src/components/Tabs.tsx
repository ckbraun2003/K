/**
 * P4 E-30 — the ONE canonical page-level tab bar (underline style). Generic over the
 * caller's tab-value union so each surface is type-safe. Accent-ink on the active
 * underline; aria-selected + role=tablist for a11y.
 */
export interface TabItem<T extends string> { value: T; label: string; icon?: string; count?: number }

export default function Tabs<T extends string>({
  items, value, onChange, ariaLabel,
}: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex items-center gap-4 border-b border-[var(--border)]">
      {items.map((t) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={active}
            data-testid={`tab-${t.value}`}
            onClick={() => onChange(t.value)}
            className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 text-xs transition-colors ${
              active ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.icon && <span aria-hidden>{t.icon}</span>}
            <span>{t.label}</span>
            {t.count != null && (
              <span className="rounded-full bg-[var(--raised)] px-1.5 text-[10px] text-[var(--muted)]">{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
