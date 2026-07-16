import { Fragment } from 'react'

/** Compact role-chain preview for a NamedWorkflow (D-016 visual language,
 *  CSS-only). Chips cycle the chart palette per position — palette hues are
 *  positional (chart series convention), not per-role semantics. */
export default function MiniDag({ roles }: { roles: string[] }) {
  if (roles.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label={`Role chain: ${roles.join(' then ')}`}>
      {roles.map((role, i) => (
        <Fragment key={`${role}-${i}`}>
          {i > 0 && (
            <span data-testid="dag-edge" aria-hidden className="h-px w-3 shrink-0 bg-border-strong" />
          )}
          <span
            className="rounded-pill border px-1.5 py-0.5 text-micro font-medium"
            style={{
              color: `var(--chart-${(i % 8) + 1})`,
              borderColor: 'var(--border)',
              background: 'var(--raised)',
            }}
          >
            {role}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
