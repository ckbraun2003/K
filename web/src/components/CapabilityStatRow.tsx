import { useQuery } from '@tanstack/react-query'
import type { CapabilitySummary } from '@k/shared'
import { api } from '../lib/api'
import { formatCompact } from '../lib/format-metrics'
import GlossaryTerm from './GlossaryTerm'

/**
 * Slim capability-cost strip shown on ALL Skills tabs — the enabled set's
 * estimated context overhead at a glance. Figures come from ONE summary read
 * (['capabilities','summary']) so every tab shows the same numbers. All values
 * are ESTIMATES of prompt-context cost — never billed tokens; entries without
 * an estimate are excluded from the sums and footnoted instead.
 */
export default function CapabilityStatRow() {
  const { data } = useQuery<CapabilitySummary>({
    queryKey: ['capabilities', 'summary'],
    queryFn: api.capabilities.summary,
  })

  const unestimated = data ? data.skills.unestimatedCount + data.mcp.unestimatedCount : 0

  return (
    <div
      data-testid="capability-stat-row"
      title={`Estimates of prompt-context weight, not billed tokens${
        unestimated > 0 ? `; ${unestimated} not yet measured excluded` : ''
      }`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2 text-[11px] text-[var(--muted)]"
    >
      {data ? (
        <>
          <span>
            Enabled skills:{' '}
            <span className="mono text-[var(--text)]">{data.skills.enabledCount}</span> ·{' '}
            <span className="mono text-[var(--text)]">~{formatCompact(data.skills.estTokens)}</span> tok
          </span>
          <span aria-hidden>—</span>
          <span>
            MCP: <span className="mono text-[var(--text)]">{data.mcp.enabledCount}</span> servers ·{' '}
            <span className="mono text-[var(--text)]">~{formatCompact(data.mcp.estTokens)}</span> tok
          </span>
          <span aria-hidden>—</span>
          <span>
            Total <GlossaryTerm term="Weight band">context weight</GlossaryTerm>:{' '}
            <span className="mono text-[var(--accent-hover)]">~{formatCompact(data.totalEstTokens)}</span> tok
          </span>
          {unestimated > 0 && (
            <span data-testid="capability-stat-unestimated" className="italic">
              · {unestimated} not yet measured
            </span>
          )}
        </>
      ) : (
        // Loading/error: never fake a zero — an em-dash strip until the read lands.
        <span>Enabled skills: — · MCP: — · Total context weight: —</span>
      )}
    </div>
  )
}
