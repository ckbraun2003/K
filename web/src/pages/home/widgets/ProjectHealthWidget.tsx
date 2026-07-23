import { useQuery } from '@tanstack/react-query'
import type { Project } from '@k/shared'
import { api } from '../../../lib/api'
import { navigate } from '../../../lib/route'
import HealthRubric from '../../../components/HealthRubric'
import { SectionHeader } from '../../../ui/SectionHeader'
import { EmptyState } from '../../../ui/EmptyState'
import { Skeleton } from '../../../ui/Skeleton'

/**
 * ProjectHealthWidget (UI Simplification Task 13) — a compact one-row-per-
 * project health roll-up, reusing the SAME `['projects']` key + `api.projects
 * .list()` the fleet grid (ProjectCard) reads, and the SAME canonical
 * `<HealthRubric>` dot+label component ProjectCard renders (never a bespoke
 * score→color map; unlike ProjectCard it renders the rubric for scoreless
 * projects too — the "unknown" band is this widget's whole point). Click-
 * through to the project workspace mirrors ProjectCard's
 * `navigate('project', id)`.
 */
export default function ProjectHealthWidget() {
  const { data: projects = [], isError, isPending } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: () => api.projects.list() })

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <SectionHeader label="Project health" as="h2" />
      {isPending ? (
        // Hand-rolled (not <SkeletonTile>): that component bakes in its own
        // glass-panel tier, which would nest backdrop-filter inside this cell's
        // GlassPanel tier="panel" ancestor (OverviewView).
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 px-1.5 py-1">
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-3 rounded-pill" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p data-testid="widget-project-health-error" className="text-caption text-red">Failed to load projects.</p>
      ) : projects.length === 0 ? (
        // FU-2: tier="solid" avoids nesting glass-panel (EmptyState's default
        // icon bubble) inside this cell's GlassPanel tier="panel" ancestor
        // (OverviewView) — backdrop-filter can't stack on itself.
        <EmptyState tier="solid" icon="projects" headline="No projects registered yet." className="flex-1 gap-1.5 py-4" />
      ) : (
        <div className="flex flex-col gap-1">
          {projects.map(p => (
            <button
              key={p.id}
              type="button"
              data-testid={`widget-project-health-row-${p.id}`}
              onClick={() => navigate('project', p.id)}
              className="flex items-center gap-2 rounded-control px-1.5 py-1 text-left text-body transition-colors hover:bg-[var(--glass-hover)]"
            >
              <span className="min-w-0 flex-1 truncate text-text">{p.name}</span>
              <span data-testid={`widget-project-health-dot-${p.id}`} className="flex-shrink-0">
                <HealthRubric score={p.healthScore ?? null} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
