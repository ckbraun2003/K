import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Run, VerificationReport, GithubStatus } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { cn } from '../../lib/cn'
import {
  scoreColor,
  barPct,
  relativeTime,
  formatTimeAgo,
  BREAKDOWN_BARS,
  BREAKDOWN_MAX,
} from '../../lib/verify'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  queued:      'bg-[var(--amber)]',
  running:     'bg-[var(--accent)]',
  done:        'bg-[var(--green)]',
  error:       'bg-[var(--red)]',
  killed:      'bg-[var(--muted)]',
  interrupted: 'bg-[var(--red)]',
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverviewTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const { data: reports = [], isLoading: reportsLoading } = useQuery<VerificationReport[]>({
    queryKey: ['verifications', projectId],
    queryFn: () => api.projects.verifications(projectId),
    enabled: !!projectId,
  })

  const { data: recentRuns = [], isLoading: runsLoading } = useQuery<Run[]>({
    queryKey: ['runs', 'project', projectId],
    queryFn: () => api.runs.list({ projectId, limit: 5 }),
    enabled: !!projectId,
  })

  const { data: github, isLoading: githubLoading } = useQuery<GithubStatus>({
    queryKey: ['github', projectId],
    queryFn: () => api.projects.github(projectId),
    enabled: !!projectId,
    retry: false,
  })
  const latest = reports.length > 0
    ? [...reports].sort((a, b) => b.startedAt - a.startedAt)[0]
    : null

  const verify = useMutation({
    mutationFn: (deep: boolean) => api.projects.verify(projectId, deep ? { deep: true } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const pending = verify.isPending

  const openPrs = (github?.prs ?? []).filter(pr => pr.state === 'OPEN')

  return (
    <div className="space-y-5 p-5">

      {/* ── Health Score ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-baseline gap-3">
          {reportsLoading ? (
            <span className="mono text-3xl font-semibold text-[var(--muted)]">…</span>
          ) : latest ? (
            <>
              <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                {latest.score}
              </span>
              <span className="text-xs text-[var(--muted)]">/ 100 health</span>
              <span className="ml-auto text-[11px] text-[var(--muted)]">
                {formatTimeAgo(latest.completedAt ?? latest.startedAt)}
              </span>
            </>
          ) : (
            <span className="text-sm text-[var(--muted)]">No verification run yet.</span>
          )}
        </div>

        {latest?.breakdown && (
          <div className="mt-4 space-y-2.5">
            {BREAKDOWN_BARS.map(({ key, label }) => {
              const value = latest.breakdown![key]
              const max = BREAKDOWN_MAX[key]
              const pct = barPct(value, max)
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--muted)]">{label}</span>
                    <span className="mono text-[var(--muted)]">{value}/{max}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--raised)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                      style={{ width: `${pct * 100}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Recent Runs ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Recent Runs
        </h3>
        {runsLoading ? (
          <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
        ) : recentRuns.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--muted)]">No runs for this project yet.</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {recentRuns.map(run => (
              <li key={run.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-[var(--raised)] transition-colors"
                  onClick={() => navigate('project', projectId, 'runs')}
                >
                  <span
                    className={cn(
                      'h-2 w-2 flex-shrink-0 rounded-full',
                      STATUS_DOT[run.status] ?? 'bg-[var(--muted)]',
                    )}
                  />
                  <span className="flex-1 truncate text-[var(--text)]">
                    {run.prompt.length > 60 ? run.prompt.slice(0, 60) + '…' : run.prompt}
                  </span>
                  <span className="mono flex-shrink-0 text-[var(--muted)]">
                    ${run.costUsd.toFixed(4)}
                  </span>
                  <span className="flex-shrink-0 text-[var(--muted)]">
                    {relativeTime(run.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Open PRs ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Open PRs
        </h3>
        {githubLoading ? (
          <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
        ) : !github ? (
          <p className="mt-2 text-xs text-[var(--muted)]">No GitHub remote configured.</p>
        ) : openPrs.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--muted)]">No open pull requests.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {openPrs.map(pr => (
              <li key={pr.number} className="flex items-center gap-2 text-xs">
                <span className="mono text-[var(--muted)]">#{pr.number}</span>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-[var(--text)] hover:text-[var(--accent)] transition-colors"
                >
                  {pr.title}
                </a>
                <span
                  className={cn(
                    'flex-shrink-0 text-[10px]',
                    pr.checks === 'passing'
                      ? 'text-[var(--green)]'
                      : pr.checks === 'failing'
                        ? 'text-[var(--red)]'
                        : 'text-[var(--amber)]',
                  )}
                >
                  {pr.checks}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Quick Actions ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => verify.mutate(false)}
          disabled={pending}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {verify.isPending ? 'verifying…' : '▶ Run Verification'}
        </button>
        <button
          onClick={() => verify.mutate(true)}
          disabled={pending}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] disabled:opacity-40"
        >
          Deep Verify
        </button>
        <button
          onClick={() => navigate('project', projectId, 'runs')}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)]"
        >
          Dispatch Agent
        </button>
        <button
          onClick={() => navigate('docs', 'ui-demo')}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)]"
        >
          🖥 UI Demo
        </button>
        {verify.error && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(verify.error)}</span>
        )}
      </div>

    </div>
  )
}
