import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { VerificationReport, WsMessage } from '@k/shared'
import { api } from '../../lib/api'
import { onWsMessage } from '../../lib/ws'
import { cn } from '../../lib/cn'
import {
  scoreColor,
  groupFindings,
  barPct,
  formatTimeAgo,
  latestReport,
  trendIndicator,
  BREAKDOWN_BARS,
  BREAKDOWN_MAX,
  SEVERITY_DOT,
} from '../../lib/verify'

// ─── Component ───────────────────────────────────────────────────────────────

export default function VerificationTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const { data: reports = [], isLoading } = useQuery<VerificationReport[]>({
    queryKey: ['verifications', projectId],
    queryFn: () => api.projects.verifications(projectId),
    enabled: !!projectId,
  })
  const latest = latestReport(reports)

  // Live: when a verification_update arrives for THIS project, refresh the
  // report list + the projects list (healthScore/lastVerifiedAt move with it).
  useEffect(() => {
    return onWsMessage((msg: WsMessage) => {
      if (msg.type === 'verification_update' && msg.report.projectId === projectId) {
        qc.invalidateQueries({ queryKey: ['verifications', projectId] })
        qc.invalidateQueries({ queryKey: ['projects'] })
      }
    })
  }, [qc, projectId])

  const reRun = useMutation({
    mutationFn: () => api.projects.verify(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const deepVerify = useMutation({
    mutationFn: () => api.projects.verify(projectId, { deep: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const pending = reRun.isPending || deepVerify.isPending
  const error = reRun.error ?? deepVerify.error

  const grouped = latest ? groupFindings(latest.findings) : []

  return (
    <div className="p-5">
      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => reRun.mutate()}
          disabled={pending}
          data-testid="verify-rerun"
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
        >
          {reRun.isPending ? 'verifying…' : '▶ Re-run'}
        </button>
        <button
          onClick={() => deepVerify.mutate()}
          disabled={pending}
          data-testid="verify-deep"
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors duration-150 hover:border-[var(--accent)] disabled:opacity-40"
        >
          {deepVerify.isPending ? 'dispatching…' : 'Deep verify'}
        </button>
        {error && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(error)}</span>
        )}
      </div>

      {isLoading ? (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading reports…</p>
      ) : !latest ? (
        <p className="mt-10 text-center text-sm text-[var(--muted)]">
          No verification reports yet. Run a verification to score this project.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          {/* Left column */}
          <div className="space-y-5">
            {/* Score + breakdown */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-baseline gap-3">
                <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                  {latest.score}
                </span>
                <span className="text-xs text-[var(--muted)]">/ 100 health</span>
                <span className="ml-auto text-[11px] text-[var(--muted)]">
                  {formatTimeAgo(latest.completedAt ?? latest.startedAt)}
                </span>
              </div>

              {latest.breakdown ? (() => {
                const bd = latest.breakdown!
                return (
                  <div className="mt-4 space-y-2.5">
                    {BREAKDOWN_BARS.map(({ key, label }) => {
                      const value = bd[key]
                      const max = BREAKDOWN_MAX[key]
                      const pct = barPct(value, max)
                      return (
                        <div key={key} data-testid={`bar-${key}`}>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-[var(--muted)]">{label}</span>
                            <span className="mono text-[var(--muted)]">{value}/{max}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
                            <motion.div
                              className="h-full rounded-full bg-[var(--accent)]"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct * 100}%` }}
                              transition={{ duration: 0.15, ease: 'easeOut' }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })() : (
                <p className="mt-3 text-[11px] text-[var(--muted)]">
                  No score breakdown on this report.
                </p>
              )}
            </div>

            {/* Findings */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Findings
              </h3>
              {grouped.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--muted)]">No findings — clean report.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {grouped.map(group =>
                    group.items.map(f => (
                      <div
                        key={`${group.severity}-${f.area}-${f.message}`}
                        className="flex items-start gap-2"
                      >
                        <span
                          className={cn(
                            'mt-1.5 h-2 w-2 flex-shrink-0 rounded-full',
                            SEVERITY_DOT[group.severity],
                          )}
                        />
                        <p className="text-xs text-[var(--text)]">
                          <span className="mono text-[var(--muted)]">{f.area}</span>
                          {' · '}
                          {f.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Fixes applied */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Fixes applied
              </h3>
              {latest.fixesApplied.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--muted)]">No fixes applied this run.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {latest.fixesApplied.map((fix, i) => (
                    <li key={`${i}-${fix}`} className="flex items-start gap-2 text-xs text-[var(--text)]">
                      <span className="text-[var(--green)]">✓</span>
                      {fix}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right column: history with sparkline trend */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
              History
            </h3>
            <ol className="mt-3 space-y-2">
              {[...reports]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(r => {
                  const trend = trendIndicator(reports, r.id)
                  const trendColor = trend.includes('▲')
                    ? 'text-[var(--green)]'
                    : trend.includes('▼')
                      ? 'text-[var(--red)]'
                      : 'text-[var(--muted)]'
                  return (
                    <li key={r.id} className="flex items-center gap-2 text-xs">
                      <span className={cn('mono font-semibold', scoreColor(r.score))}>{r.score}</span>
                      <span className={cn('mono text-[10px]', trendColor)}>{trend}</span>
                      <span className="text-[var(--muted)]">{formatTimeAgo(r.startedAt)}</span>
                      {r.id === latest.id && (
                        <span className="ml-auto text-[10px] text-[var(--accent)]">latest</span>
                      )}
                    </li>
                  )
                })}
            </ol>
          </div>
        </div>
      )}
    </div>
  )
}
