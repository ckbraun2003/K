import { useQuery } from '@tanstack/react-query'
import type { GithubStatus, PrInfo, CiRunInfo } from '@k/shared'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'

interface Props {
  projectId: string
}

function timeAgo(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs == null) return 'never'
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (Number.isNaN(ts)) return 'unknown'
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

const CHECK_DOT: Record<string, string> = {
  passing: 'bg-[var(--green)]',
  failing:  'bg-[var(--red)]',
  pending:  'bg-[var(--amber)] glow-live',
  none:     'bg-[var(--muted)]',
}

function ciConclusionColor(conclusion: string | null, status: string): string {
  if (status === 'in_progress' || status === 'queued') return 'text-[var(--amber)]'
  if (conclusion === 'success') return 'text-[var(--green)]'
  if (conclusion === 'failure' || conclusion === 'cancelled') return 'text-[var(--red)]'
  return 'text-[var(--muted)]'
}

function ciLabel(run: CiRunInfo): string {
  if (run.status === 'in_progress') return 'in progress'
  if (run.status === 'queued') return 'queued'
  return run.conclusion ?? run.status
}

function PrRow({ pr }: { pr: PrInfo }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors">
      {/* Check dot */}
      <span className={cn('mt-1 w-2 h-2 rounded-full flex-shrink-0', CHECK_DOT[pr.checks] ?? 'bg-[var(--muted)]')} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--muted)]">#{pr.number}</span>
          <p className="text-sm text-[var(--text)] truncate">{pr.title}</p>
        </div>
        <p className="font-mono text-[10px] text-[var(--muted)] mt-0.5">checks: {pr.checks}</p>
      </div>

      {/* External link */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        title="Open on GitHub"
        className="flex-shrink-0 text-[var(--muted)] hover:text-[var(--accent-hover)] transition-colors text-xs mt-0.5"
        aria-label="Open PR on GitHub"
      >
        ↗
      </a>
    </div>
  )
}

function CiRow({ run }: { run: CiRunInfo }) {
  const color = ciConclusionColor(run.conclusion, run.status)
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-[var(--text)] truncate">{run.workflow}</p>
          <span className={cn('font-mono text-xs flex-shrink-0', color)}>{ciLabel(run)}</span>
        </div>
        <p className="font-mono text-[10px] text-[var(--muted)] mt-0.5">
          {run.branch} · {timeAgo(run.createdAt)}
        </p>
      </div>
      <span className="font-mono text-[10px] text-[var(--muted)] flex-shrink-0">
        #{run.id}
      </span>
    </div>
  )
}

export default function PrsCiTab({ projectId }: Props) {
  const { data: github, isLoading, error } = useQuery<GithubStatus>({
    queryKey: ['github', projectId],
    queryFn: () => api.projects.github(projectId),
    refetchInterval: 60_000,
  })

  const openPrs = github?.prs.filter(p => p.state === 'OPEN') ?? []
  const ciRuns = github?.ci ?? []

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header bar */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            disabled
            title="PR creation coming in G-5"
            className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs font-semibold text-[var(--muted)] opacity-40 cursor-not-allowed"
          >
            + Open PR
          </button>
        </div>
        <span className="font-mono text-[10px] text-[var(--muted)]">
          {github?.fetchedAt != null
            ? `Updated ${timeAgo(github.fetchedAt)}`
            : isLoading
            ? 'Loading…'
            : error
            ? 'Fetch failed'
            : 'Never fetched'}
        </span>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--muted)]">
          Loading GitHub status…
        </div>
      )}

      {error && !isLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--red)]">
          Failed to load GitHub status: {String(error)}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* PRs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-[var(--raised)] border-b border-[var(--border)]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Open PRs · {openPrs.length}
              </h3>
            </div>
            {openPrs.length === 0 ? (
              <div className="px-4 py-4 text-xs text-[var(--muted)]">No open PRs.</div>
            ) : (
              openPrs.map(pr => <PrRow key={pr.number} pr={pr} />)
            )}
          </div>

          {/* CI Runs section */}
          <div className="flex-shrink-0">
            <div className="px-4 py-2 bg-[var(--raised)] border-b border-[var(--border)]">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                CI Runs · {ciRuns.length}
              </h3>
            </div>
            {ciRuns.length === 0 ? (
              <div className="px-4 py-4 text-xs text-[var(--muted)]">No CI runs.</div>
            ) : (
              ciRuns.map(run => <CiRow key={run.id} run={run} />)
            )}
          </div>
        </>
      )}
    </div>
  )
}
