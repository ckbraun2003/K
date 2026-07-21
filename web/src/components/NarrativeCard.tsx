import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RunNarrative } from '@k/shared'
import { api } from '../lib/api'
import Markdown from './Markdown'
import { StatusPill } from '../ui/StatusPill'
import { Tag } from '../ui/Tag'
import { IconButton } from '../ui/Button'

/** localStorage key for the per-run collapsed state — see the component doc below. */
const collapseKey = (runId: string) => `narrative-collapsed:${runId}`

const DEGRADE_NOTE: Record<Exclude<RunNarrative['bulletsState'], 'ok'>, string> = {
  unavailable: 'local model unavailable - insights skipped',
  disabled: 'local-model insights disabled',
  error: 'local model returned no usable insights - skipped',
}

function fmtUsd(n: number): string { return `$${n.toFixed(n < 0.01 ? 4 : 2)}` }
function fmtInt(n: number): string { return n.toLocaleString() }

export default function NarrativeCard({ runId }: { runId: string }) {
  const { data: n } = useQuery<RunNarrative>({
    queryKey: ['run-narrative', runId],
    queryFn: () => api.runs.narrative(runId),
  })
  // Lane B (ui-adjustments Round 2): collapsed state persists per-run in
  // localStorage so re-opening the same run remembers the operator's choice.
  // Default EXPANDED (missing/invalid key reads as false). Re-derived whenever
  // `runId` changes — the component doesn't remount across a run switch (RunConsole
  // renders one persistent <NarrativeCard runId={runId} />), so a plain lazy
  // useState initializer alone would carry the PREVIOUS run's collapsed state
  // across the switch; the effect corrects it from the new key.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey(runId)) === '1')
  useEffect(() => {
    setCollapsed(localStorage.getItem(collapseKey(runId)) === '1')
  }, [runId])
  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem(collapseKey(runId), next ? '1' : '0')
      return next
    })
  }

  if (!n) return null
  // Branch on bulletsState alone (not the compound `state === 'ok' && bullets`
  // condition below) so TS narrows the Exclude<..., 'ok'> index cleanly.
  const degradeNote = n.bulletsState === 'ok' ? null : DEGRADE_NOTE[n.bulletsState]

  return (
    <section data-testid="narrative-card" className="glass-panel p-3 text-label mx-5 mb-3 flex-shrink-0">
      <header className="mb-2 flex items-center gap-2">
        <IconButton
          name={collapsed ? 'chevronRight' : 'chevronDown'}
          label={collapsed ? 'Expand run narrative' : 'Collapse run narrative'}
          variant="ghost"
          size="sm"
          data-testid="narrative-collapse-toggle"
          onClick={toggleCollapsed}
          className="-ml-1"
        />
        <span className="font-semibold text-text">Run narrative</span>
        {/* outcome.status is a canonical Run status literal — StatusPill, not a
            bespoke badge (icon + label, never color alone). */}
        <StatusPill status={n.outcome.status} />
      </header>

      {!collapsed && (
        <>
          {/* deterministic fields (computed from events/verify/run) */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Goal</dt>
            <dd data-testid="narrative-goal" className="text-text"><Markdown inline text={n.goal} /></dd>

            <dt className="text-muted">Files</dt>
            <dd className="mono text-text">
              {n.files.length ? n.files.join(', ') : <span className="text-muted">none recorded</span>}
            </dd>

            <dt className="text-muted">Verification</dt>
            <dd data-testid="narrative-verify" className="text-text">
              {n.verification
                ? `${n.verification.status}${n.verification.reason ? ` - ${n.verification.reason}` : ''} (${n.verification.commandCount} cmd)`
                : <span className="text-muted">not run</span>}
            </dd>

            <dt className="text-muted">Cost</dt>
            <dd className="mono tabular-nums text-text">
              {fmtUsd(n.cost.costUsd)} - {fmtInt(n.cost.tokensIn)} in / {fmtInt(n.cost.tokensOut)} out
            </dd>
          </dl>

          {/* local-model insights (physically separated, always labeled "generated") */}
          <div className="mt-3 border-t border-border pt-2">
            {n.bulletsState === 'ok' && n.bullets ? (
              <div data-testid="narrative-bullets">
                <div className="mb-1 flex items-center gap-1.5">
                  <Tag tint="neutral" className="text-micro uppercase tracking-wide">
                    generated - {n.bullets.model}
                  </Tag>
                </div>
                {n.bullets.decisions.length > 0 && (
                  <>
                    <div className="micro-label">Decisions</div>
                    <ul className="mb-1 list-disc pl-4 text-label text-text">
                      {n.bullets.decisions.map((d, i) => <li key={`d${i}`}><Markdown inline text={d} /></li>)}
                    </ul>
                  </>
                )}
                {n.bullets.risks.length > 0 && (
                  <>
                    <div className="micro-label">Risks</div>
                    <ul className="list-disc pl-4 text-label text-text">
                      {n.bullets.risks.map((r, i) => <li key={`r${i}`}><Markdown inline text={r} /></li>)}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <div data-testid="narrative-bullets-note" className="text-micro italic text-muted">
                {degradeNote}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
