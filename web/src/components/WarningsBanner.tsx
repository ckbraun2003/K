import type { CatalogWarning } from '@k/shared'

/** Amber non-fatal discovery warnings (unreadable dirs, malformed SKILL.md,
 *  unparseable configs) — shared banner for the catalog/MCP/hooks tabs. */
export default function WarningsBanner({ warnings }: { warnings: CatalogWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <div
      data-testid="catalog-warnings"
      className="mb-4 rounded-xl border border-[color:rgba(251,191,36,0.4)] bg-[color:rgba(251,191,36,0.08)] px-4 py-3"
    >
      <p className="text-xs font-semibold text-[var(--amber)]">
        Discovery reported {warnings.length} warning{warnings.length > 1 ? 's' : ''} — these host
        sources were skipped, not failed:
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {warnings.map((w, i) => (
          <li key={`${w.path}-${i}`} className="text-[11px] text-[var(--muted)]">
            <span className="mono text-[var(--amber)]">{w.path}</span> — {w.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
