import ForceGraph2D from 'react-force-graph-2d'
import type { Project } from '@k/shared'
import { navigate } from '../lib/route'

type FGNode = { id?: string | number; [key: string]: unknown }

interface Props {
  projects: Project[]
}

function healthColor(healthScore: number | undefined | null): string {
  if (healthScore == null) return '#8b8b93'
  if (healthScore >= 75) return '#22c55e'
  if (healthScore >= 50) return '#eab308'
  return '#ef4444'
}

export default function HomeFleetGraph({ projects }: Props) {
  const graphData = {
    nodes: projects.map(p => ({
      id: p.id,
      label: p.name,
      val: 3,
      color: healthColor(p.healthScore),
    })),
    links: [] as { source: string; target: string }[],
  }

  return (
    <div className="relative mt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Fleet Graph
        </h2>
        <button
          onClick={() => navigate('graph')}
          className="text-xs text-[var(--accent-hover)] transition-colors duration-150 hover:text-[var(--text)]"
          title="Open full-screen fleet graph"
        >
          ↗ expand
        </button>
      </div>
      <div className="mt-2 overflow-hidden rounded-lg border border-[var(--border)]">
        {projects.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-[var(--muted)]">
            No projects yet.
          </div>
        ) : (
          <ForceGraph2D
            graphData={graphData}
            height={280}
            backgroundColor="#0a0a0f"
            nodeLabel="label"
            onNodeClick={(node: FGNode) => {
              if (node.id) navigate('project', node.id as string)
            }}
            enableNodeDrag={false}
            enableZoomInteraction
            enablePanInteraction
          />
        )}
      </div>
    </div>
  )
}
