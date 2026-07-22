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
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { EmptyState } from '../../ui/EmptyState'

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
        <Button
          variant="primary"
          size="sm"
          onClick={() => reRun.mutate()}
          disabled={pending}
          loading={reRun.isPending}
          data-testid="verify-rerun"
        >
          {reRun.isPending ? 'verifying…' : 'Re-run'}
        </Button>
        <Button
          variant="glass"
          size="sm"
          onClick={() => deepVerify.mutate()}
          disabled={pending}
          loading={deepVerify.isPending}
          data-testid="verify-deep"
        >
          {deepVerify.isPending ? 'dispatching…' : 'Deep verify'}
        </Button>
        {error && (
          <span className="flex items-center gap-1 text-[11px] text-red">
            <Icon name="warning" size={14} />
            {String(error)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-muted">
          <Spinner size={16} /> Loading reports…
        </div>
      ) : !latest ? (
        <div className="mt-10">
          <EmptyState
            icon="check"
            headline="No verification reports yet."
            hint="Run a verification to score this project."
            cta={{ label: 'Run verification', onClick: () => reRun.mutate() }}
          />
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          {/* Left column */}
          <div className="space-y-5">
            {/* Score + breakdown */}
            <div className="rounded-panel border border-[var(--glass-tier-border)] bg-[var(--glass-2)] p-4">
              <div className="flex items-baseline gap-3">
                <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                  {latest.score ?? '—'}
                </span>
                <span className="text-xs text-muted">
                  {latest.score == null ? 'insufficient signal' : '/ 100 health'}
                </span>
                <span className="ml-auto text-[11px] text-muted">
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
                            <span className="text-muted">{label}</span>
                            <span className="mono text-muted">
                              {value == null ? 'not measured' : `${value}/${max}`}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                            <motion.div
                              className="h-full rounded-full bg-accent"
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
                <p className="mt-3 text-[11px] text-muted">
                  No score breakdown on this report.
                </p>
              )}
            </div>

            {/* Findings */}
            <div className="rounded-panel border border-[var(--glass-tier-border)] bg-[var(--glass-2)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Findings
              </h3>
              {grouped.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No findings — clean report.</p>
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
                        <p className="text-xs text-text">
                          <span className="mono text-muted">{f.area}</span>
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
            <div className="rounded-panel border border-[var(--glass-tier-border)] bg-[var(--glass-2)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Fixes applied
              </h3>
              {latest.fixesApplied.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No fixes applied this run.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {latest.fixesApplied.map((fix, i) => (
                    <li key={`${i}-${fix}`} className="flex items-start gap-2 text-xs text-text">
                      <Icon name="check" size={14} className="text-green" />
                      {fix}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right column: history with sparkline trend */}
          <div className="rounded-panel border border-[var(--glass-tier-border)] bg-[var(--glass-2)] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              History
            </h3>
            <ol className="mt-3 space-y-2">
              {[...reports]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(r => {
                  const trend = trendIndicator(reports, r.id)
                  const trendColor = trend.includes('▲')
                    ? 'text-green'
                    : trend.includes('▼')
                      ? 'text-red'
                      : 'text-muted'
                  return (
                    <li key={r.id} className="flex items-center gap-2 text-xs">
                      <span className={cn('mono font-semibold', scoreColor(r.score))}>{r.score ?? '—'}</span>
                      <span className={cn('mono text-[10px]', trendColor)}>{trend}</span>
                      <span className="text-muted">{formatTimeAgo(r.startedAt)}</span>
                      {r.id === latest.id && (
                        <span className="ml-auto text-[10px] text-accent">latest</span>
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
