import { useQuery } from '@tanstack/react-query'
import type { Project, GithubStatus } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

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
  const attention = ci === 'failing'

  return (
    <div
      className={cn(
        'card-lift rounded-lg border bg-[var(--surface)] p-4',
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
    </div>
  )
}
