import { useQuery } from '@tanstack/react-query'
import type { MetricsSummary, Project } from '@k/shared'
import { api } from '../lib/api'
import MetricCard from '../components/MetricCard'
import ProjectCard from '../components/ProjectCard'
import HomeFleetGraph from './HomeFleetGraph'
import GettingStarted from '../components/GettingStarted'
import { useFleetGithub } from '../lib/useFleetGithub'
import { navigate } from '../lib/route'

export default function Home() {
  const { data: metrics } = useQuery<MetricsSummary>({
    queryKey: ['metrics'],
    queryFn: api.metrics.summary,
    refetchInterval: 30_000,
  })
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  const githubFor = useFleetGithub()

  const spark = (pick: (d: MetricsSummary['daily'][number]) => number) =>
    metrics ? metrics.daily.map(pick) : undefined

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      {/* hero header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">Command Deck</h1>
        <p className="mt-0.5 text-sm text-[var(--muted)]">Your fleet at a glance — runs, cost & project health.</p>
      </div>

      {/* metrics row */}
      <div className="flex flex-wrap gap-4">
        <MetricCard
          label="Tokens today"
          value={metrics ? `${(metrics.today.tokens / 1000).toFixed(1)}k` : '—'}
          spark={spark(d => d.tokens)}
        />
        <MetricCard
          label="Cost today"
          value={metrics ? `$${metrics.today.costUsd.toFixed(2)}` : '—'}
          spark={spark(d => d.costUsd)}
        />
        <MetricCard label="Active runs" value={metrics ? String(metrics.activeRuns) : '—'} accent />
        <MetricCard label="Runs today" value={metrics ? String(metrics.today.runs) : '—'} spark={spark(d => d.runs)} />
        <MetricCard label="Total runs" value={metrics ? String(metrics.totalRuns) : '—'} />
      </div>

      {/* getting started — dismissible first-run guidance; forced open while empty */}
      <GettingStarted
        projects={projects}
        forceOpen={projects.length === 0}
        onRegister={() => navigate('projects')}
      />

      {/* projects */}
      <div className="mt-7 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Projects</h2>
        <button
          onClick={() => navigate('projects')}
          className="text-xs text-[var(--accent-hover)] transition-colors duration-150 hover:text-[var(--text)]"
        >
          manage →
        </button>
      </div>
      {projects.length === 0 ? (
        <button
          onClick={() => navigate('projects')}
          className="card-lift mt-3 flex w-full items-center justify-center rounded-panel border border-dashed border-[var(--border)] py-10 text-sm text-[var(--muted)] hover:text-[var(--text)]"
        >
          + register your first project
        </button>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 xl:grid-cols-3">
          {projects.map(p => <ProjectCard key={p.id} project={p} gh={githubFor(p.id)} />)}
        </div>
      )}

      {/* Fleet Graph */}
      <HomeFleetGraph projects={projects} />
    </div>
  )
}
