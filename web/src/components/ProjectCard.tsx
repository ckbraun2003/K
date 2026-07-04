import type { Project, GithubStatus, Run } from '@k/shared'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import { formatTimeAgo, relativeTime } from '../lib/verify'

// A health score below this flags the card for attention alongside failing CI.
const LOW_HEALTH_THRESHOLD = 50

// Run-status → dot color for the last-run line.
const RUN_DOT: Record<string, string> = {
  queued:      'bg-[var(--amber)]',
  running:     'bg-[var(--accent)]',
  done:        'bg-[var(--green)]',
  error:       'bg-[var(--red)]',
  killed:      'bg-[var(--muted)]',
  interrupted: 'bg-[var(--red)]',
}

function ciState(gh?: GithubStatus): 'passing' | 'failing' | 'unknown' {
  const latest = gh?.ci?.[0]
  if (!latest || !latest.conclusion) return 'unknown'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

// `gh` is supplied by the parent grid via a single fleet-level query
// (lib/useFleetGithub) rather than a per-card fetch — see Wave C6: N cards used
// to fire N parallel /github requests, exhausting the browser socket pool.
export default function ProjectCard({
  project,
  gh,
  lastRun,
  onDelete,
}: {
  project: Project
  gh?: GithubStatus
  /** Most recent run for this project (fleet-level batch from the parent grid) —
   *  surfaces last-run status + when on the card (F-065). */
  lastRun?: Run | null
  onDelete?: () => void
}) {
  const ci = ciState(gh)
  const openPrs = gh?.prs.filter(p => p.state === 'OPEN').length ?? 0
  const lowHealth = project.healthScore != null && project.healthScore < LOW_HEALTH_THRESHOLD
  const attention = ci === 'failing' || lowHealth
  const goWorkspace = () => navigate('project', project.id)
  const goVerify = () => navigate('verify', project.id)

  return (
    <div
      data-testid={`project-card-${project.id}`}
      role="button"
      tabIndex={0}
      onClick={goWorkspace}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goWorkspace() } }}
      className={cn(
        'card-lift group relative cursor-pointer rounded-panel border bg-[var(--surface)] p-4',
        attention ? 'border-amber/40' : 'border-[var(--border)]'
      )}
    >
      {onDelete && (
        <button
          data-testid={`project-delete-btn-${project.id}`}
          onClick={e => { e.stopPropagation(); onDelete() }}
          aria-label={`Delete project ${project.name}`}
          title="Delete project"
          className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-control text-[var(--muted)] opacity-0 transition-all duration-150 hover:bg-red/15 hover:text-[var(--red)] focus:opacity-100 group-hover:opacity-100"
        >
          🗑
        </button>
      )}
      <div className="flex items-center gap-2 pr-7">
        <span
          className={cn('h-2 w-2 rounded-full', {
            'bg-[var(--green)]': ci === 'passing',
            'bg-[var(--amber)] glow-live': ci === 'failing',
            'bg-[var(--muted)]': ci === 'unknown',
          })}
        />
        <span className="truncate text-sm font-semibold text-[var(--text)]">{project.name}</span>
        {project.healthScore != null && (
          <span className="mono ml-auto text-xs text-[var(--muted)]">{project.healthScore}/100</span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-[var(--muted)]">
        {project.githubRemote ? (
          <>
            <span className={ci === 'failing' ? 'text-[var(--amber)]' : ''}>
              CI {ci === 'passing' ? '✓' : ci === 'failing' ? '✗ failing' : '—'}
            </span>
            {' · '}{openPrs} open PR{openPrs === 1 ? '' : 's'}
          </>
        ) : (
          'no GitHub remote — registry invariant unmet'
        )}
      </p>
      <p className="mono mt-2 truncate text-[10px] text-[var(--muted)] opacity-60">{project.localPath}</p>
      {lastRun && (
        <p
          data-testid={`project-card-lastrun-${project.id}`}
          className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--muted)]"
        >
          <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', RUN_DOT[lastRun.status] ?? 'bg-[var(--muted)]')} />
          <span className="truncate">last run {lastRun.status} · {relativeTime(lastRun.createdAt)}</span>
        </p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className={cn('text-[10px]', lowHealth ? 'text-[var(--amber)]' : 'text-[var(--muted)]')}>
          {formatTimeAgo(project.lastVerifiedAt)}
        </span>
        <button
          data-testid={`project-verify-btn-${project.id}`}
          onClick={e => { e.stopPropagation(); goVerify() }}
          className="text-[11px] font-medium text-[var(--accent-hover)] transition-opacity duration-150 hover:opacity-80"
        >
          ▶ Run verification
        </button>
      </div>
    </div>
  )
}
