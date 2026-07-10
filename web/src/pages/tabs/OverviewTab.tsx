import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Run, VerificationReport, GithubStatus, Project } from '@k/shared'
import { api, type OnboardResult } from '../../lib/api'
import { navigate } from '../../lib/route'
import { cn } from '../../lib/cn'
import { runStatusMeta } from '../../lib/status'
import {
  scoreColor,
  barPct,
  relativeTime,
  formatTimeAgo,
  BREAKDOWN_BARS,
  BREAKDOWN_MAX,
} from '../../lib/verify'

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
  // The project record (app-wide cached ['projects']) for the remote chip.
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  })
  const project = projects.find(p => p.id === projectId)
  // F-033: when the repo folder is gone, arming Onboard/Dispatch/Verify would act
  // against a missing path — disable them and show a banner.
  const pathMissing = project?.pathMissing === true
  const latest = reports.length > 0
    ? [...reports].sort((a, b) => b.startedAt - a.startedAt)[0]
    : null

  // Status chips for parity with the fleet cards (F-053): remote · bible · CI. The
  // bible signal comes from the latest verification breakdown (>0 ⇒ a bible was
  // scored); CI from the newest GitHub Actions run's conclusion.
  const ciConclusion = github?.ci?.[0]?.conclusion ?? null
  const ciChip: { label: string; tone: string } =
    ciConclusion == null
      ? { label: 'CI —', tone: 'text-[var(--muted)]' }
      : ciConclusion === 'success'
        ? { label: 'CI ✓', tone: 'text-[var(--green)]' }
        : { label: 'CI ✗', tone: 'text-[var(--amber)]' }
  const bibleChip: { label: string; tone: string } =
    latest?.breakdown?.bible == null
      // null breakdown OR an UNMEASURED bible (a bare scaffold) → not scored, show —.
      ? { label: 'bible —', tone: 'text-[var(--muted)]' }
      : latest.breakdown.bible > 0
        ? { label: 'bible ✓', tone: 'text-[var(--green)]' }
        : { label: 'bible ✗', tone: 'text-[var(--amber)]' }
  const remoteChip: { label: string; tone: string } = project?.githubRemote
    ? { label: `remote ✓ ${project.githubRemote}`, tone: 'text-[var(--green)]' }
    : { label: 'no remote', tone: 'text-[var(--amber)]' }

  const verify = useMutation({
    mutationFn: (deep: boolean) => api.projects.verify(projectId, deep ? { deep: true } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verifications', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const pending = verify.isPending

  // Onboard — scaffolds the bible §3 invariants (starter bible + CI) for projects
  // that were registered before they had them. Surfaces what it created.
  const [onboardResult, setOnboardResult] = useState<OnboardResult | null>(null)
  const onboard = useMutation({
    mutationFn: () => api.projects.onboard(projectId),
    onSuccess: result => {
      setOnboardResult(result)
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['github', projectId] })
    },
  })

  const openPrs = (github?.prs ?? []).filter(pr => pr.state === 'OPEN')

  return (
    <div className="space-y-5 p-5">

      {/* ── Path-missing banner (F-033) ─────────────────────────────────────── */}
      {pathMissing && (
        <div
          data-testid="overview-path-missing"
          className="rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/10 px-4 py-3 text-xs text-[var(--red)]"
        >
          <span className="font-semibold">⚠ Repo folder missing on disk.</span>{' '}
          <span className="text-[var(--muted)]">
            <span className="mono">{project?.localPath}</span> no longer exists — Onboard, Dispatch and
            Verify are disabled until the folder is restored or the project is removed.
          </span>
        </div>
      )}

      {/* ── Status chips (remote · bible · CI) — parity with the fleet cards ── */}
      <div data-testid="overview-chips" className="flex flex-wrap items-center gap-2">
        {[remoteChip, bibleChip, ciChip].map(chip => (
          <span
            key={chip.label}
            className={cn(
              'mono rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-[10px]',
              chip.tone,
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>

      {/* ── Health Score ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-baseline gap-3">
          {reportsLoading ? (
            <span className="mono text-3xl font-semibold text-[var(--muted)]">…</span>
          ) : latest ? (
            <>
              <span className={cn('mono text-3xl font-semibold', scoreColor(latest.score))}>
                {latest.score ?? '—'}
              </span>
              <span className="text-xs text-[var(--muted)]">
                {latest.score == null ? 'insufficient signal' : '/ 100 health'}
              </span>
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
                    <span className="mono text-[var(--muted)]">
                      {value == null ? 'not measured' : `${value}/${max}`}
                    </span>
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
                      runStatusMeta(run.status).dot,
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
          disabled={pending || pathMissing}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {verify.isPending ? 'verifying…' : '▶ Run Verification'}
        </button>
        <button
          onClick={() => verify.mutate(true)}
          disabled={pending || pathMissing}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Deep Verify
        </button>
        <button
          onClick={() => navigate('project', projectId, 'knowledge-graph')}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)]"
        >
          ◉ Build graph
        </button>
        <button
          onClick={() => onboard.mutate()}
          disabled={onboard.isPending || pathMissing}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          title={pathMissing ? 'Path missing — restore the repo folder first' : 'Scaffold the starter bible + CI workflow if missing'}
        >
          {onboard.isPending ? 'onboarding…' : '✦ Onboard'}
        </button>
        <button
          onClick={() => { if (!pathMissing) navigate('project', projectId, 'runs') }}
          disabled={pathMissing}
          title={pathMissing ? 'Path missing — restore the repo folder first' : undefined}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
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
        {onboard.error && (
          <span className="text-[11px] text-[var(--red)]">⚠ {String(onboard.error)}</span>
        )}
      </div>

      {/* ── Onboard result notice ─────────────────────────────────────── */}
      {onboardResult && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[var(--text)]">Onboarding complete</span>
            <button
              onClick={() => setOnboardResult(null)}
              className="text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              aria-label="Dismiss onboarding notice"
            >
              ✕
            </button>
          </div>
          <p className="mt-1.5 text-[var(--muted)]">
            {onboardResult.created.length === 0
              ? 'All bible invariants already satisfied — nothing to scaffold.'
              : `Scaffolded ${onboardResult.created.length} file${onboardResult.created.length === 1 ? '' : 's'}.`}
          </p>
          {onboardResult.created.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {onboardResult.created.map(f => (
                <li key={f} className="mono text-[10px] text-[var(--muted)]">+ {f}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-3 text-[10px]">
            {(['githubRemote', 'bible', 'ci'] as const).map(k => (
              <span
                key={k}
                className={onboardResult.invariants[k] ? 'text-[var(--green)]' : 'text-[var(--amber)]'}
              >
                {onboardResult.invariants[k] ? '✓' : '○'} {k}
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
