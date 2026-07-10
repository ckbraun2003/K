import { useQuery } from '@tanstack/react-query'
import type { RunNarrative } from '@k/shared'
import { api } from '../lib/api'
import { runStatusMeta } from '../lib/status'

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
  if (!n) return null
  const meta = runStatusMeta(n.outcome.status)
  // Branch on bulletsState alone (not the compound `state === 'ok' && bullets`
  // condition below) so TS narrows the Exclude<..., 'ok'> index cleanly.
  const degradeNote = n.bulletsState === 'ok' ? null : DEGRADE_NOTE[n.bulletsState]

  return (
    <section data-testid="narrative-card" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
      <header className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-[var(--text)]">Run narrative</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${meta.badge}`}>{meta.label}</span>
      </header>

      {/* deterministic fields (computed from events/verify/run) */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-[var(--muted)]">Goal</dt>
        <dd data-testid="narrative-goal" className="text-[var(--text)]">{n.goal}</dd>

        <dt className="text-[var(--muted)]">Files</dt>
        <dd className="mono text-[var(--text)]">
          {n.files.length ? n.files.join(', ') : <span className="text-[var(--muted)]">none recorded</span>}
        </dd>

        <dt className="text-[var(--muted)]">Verification</dt>
        <dd data-testid="narrative-verify" className="text-[var(--text)]">
          {n.verification
            ? `${n.verification.status}${n.verification.reason ? ` - ${n.verification.reason}` : ''} (${n.verification.commandCount} cmd)`
            : <span className="text-[var(--muted)]">not run</span>}
        </dd>

        <dt className="text-[var(--muted)]">Cost</dt>
        <dd className="mono text-[var(--text)]">
          {fmtUsd(n.cost.costUsd)} - {fmtInt(n.cost.tokensIn)} in / {fmtInt(n.cost.tokensOut)} out
        </dd>
      </dl>

      {/* local-model insights (physically separated, always labeled "generated") */}
      <div className="mt-3 border-t border-[var(--border)] pt-2">
        {n.bulletsState === 'ok' && n.bullets ? (
          <div data-testid="narrative-bullets">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                generated - {n.bullets.model}
              </span>
            </div>
            {n.bullets.decisions.length > 0 && (
              <>
                <div className="text-[10px] font-semibold uppercase text-[var(--muted)]">Decisions</div>
                <ul className="mb-1 list-disc pl-4 text-[var(--text)]">
                  {n.bullets.decisions.map((d, i) => <li key={`d${i}`}>{d}</li>)}
                </ul>
              </>
            )}
            {n.bullets.risks.length > 0 && (
              <>
                <div className="text-[10px] font-semibold uppercase text-[var(--muted)]">Risks</div>
                <ul className="list-disc pl-4 text-[var(--text)]">
                  {n.bullets.risks.map((r, i) => <li key={`r${i}`}>{r}</li>)}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div data-testid="narrative-bullets-note" className="text-[10px] italic text-[var(--muted)]">
            {degradeNote}
          </div>
        )}
      </div>
    </section>
  )
}
