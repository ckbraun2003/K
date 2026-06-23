import { useQuery } from '@tanstack/react-query'
import type { Project, GithubStatus } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import { formatTimeAgo } from '../lib/verify'

// A health score below this flags the card for attention alongside failing CI.
const LOW_HEALTH_THRESHOLD = 50

function ciState(gh?: GithubStatus): 'passing' | 'failing' | 'unknown' {
  const latest = gh?.ci?.[0]
  if (!latest || !latest.conclusion) return 'unknown'
  return latest.conclusion === 'success' ? 'passing' : 'failing'
}

export default function ProjectCard({ project }: { project: Project }) {
  const { data: gh } = useQuery<GithubStatus>({
    queryKey: ['github', project.id],
    queryFn: () => api.projects.github(project.id),
    refetchInterval: 60_000,
  })
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
        'card-lift cursor-pointer rounded-lg border bg-[var(--surface)] p-4',
        attention ? 'border-amber/40' : 'border-[var(--border)]'
      )}
    >
      <div className="flex items-center gap-2">
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
