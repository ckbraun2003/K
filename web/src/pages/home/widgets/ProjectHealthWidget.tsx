import { useQuery } from '@tanstack/react-query'
import type { Project } from '@k/shared'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'
import { healthRubric } from '../../../lib/health'

/**
 * ProjectHealthWidget (UI Simplification Task 13) — a compact one-row-per-
 * project health roll-up, reusing the SAME `['projects']` key + `api.projects
 * .list()` the fleet grid (ProjectCard) reads, and the canonical E-12
 * `healthRubric()` band (never a bespoke score→color map). Click-through to
 * the project workspace mirrors ProjectCard's `navigate('project', id)`.
 */
export default function ProjectHealthWidget() {
  const { data: projects = [], isError } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: () => api.projects.list() })

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Project health</h2>
      {isError ? (
        <p data-testid="widget-project-health-error" className="text-xs italic text-[var(--red)]">Failed to load projects.</p>
      ) : projects.length === 0 ? (
        <p className="text-sm italic text-[var(--muted)]">No projects registered yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {projects.map(p => {
            const rubric = healthRubric(p.healthScore ?? null)
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`widget-project-health-row-${p.id}`}
                onClick={() => navigate('project', p.id)}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-[var(--raised)]"
              >
                <span data-testid={`widget-project-health-dot-${p.id}`} className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${rubric.dot}`} />
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{p.name}</span>
                <span className={`flex-shrink-0 text-[10px] ${rubric.text}`}>{rubric.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
