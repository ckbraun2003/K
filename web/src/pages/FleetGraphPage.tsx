import { useRef, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ForceGraph2D from 'react-force-graph-2d'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { GRAPH_BG, drawGraphNode, paintNodePointerArea } from '../lib/graph'

type FGNode = { id?: string | number; color?: string; [key: string]: unknown }

function healthColor(healthScore: number | undefined | null): string {
  if (healthScore == null) return '#a99bc4'
  if (healthScore >= 75) return '#34d399'
  if (healthScore >= 50) return '#fbbf24'
  return '#f87171'
}

const FLEET_LEGEND: { color: string; label: string }[] = [
  { color: '#34d399', label: 'Healthy (≥75)' },
  { color: '#fbbf24', label: 'At risk (≥50)' },
  { color: '#f87171', label: 'Failing (<50)' },
  { color: '#a99bc4', label: 'Unverified' },
]

export default function FleetGraphPage() {
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
    refetchInterval: 30_000,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ width: 1200, height: 700 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        setDims({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const graphData = {
    nodes: projects.map(p => ({
      id: p.id,
      label: p.name,
      val: 6,
      color: healthColor(p.healthScore),
    })),
    // Cross-project dependency edges aren't derivable yet: the fleet view is fed only
    // by GET /projects (independent project records with no inter-project relation).
    // Leave nodes-only until a backend data source for fleet dependencies exists.
    links: [] as { source: string; target: string }[],
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-5 py-3">
        <button
          onClick={() => navigate('home')}
          className="text-xs text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
        >
          ← Home
        </button>
        <h2 className="text-sm font-semibold text-[var(--text)]">Fleet Graph</h2>
        <span className="font-mono ml-2 text-[11px] text-[var(--muted)]">
          {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Graph */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            No projects registered. Go to Projects to add one.
          </div>
        ) : (
          <>
            <ForceGraph2D
              graphData={graphData}
              width={dims.width}
              height={dims.height}
              backgroundColor={GRAPH_BG}
              nodeLabel="label"
              nodeCanvasObject={(node: FGNode, ctx, scale) => drawGraphNode(node, ctx, scale, node.color ?? '#a99bc4', 7)}
              nodePointerAreaPaint={(node: FGNode, color, ctx) => paintNodePointerArea(node, ctx, color, 7)}
              onNodeClick={(node: FGNode) => {
                if (node.id) navigate('project', node.id as string)
              }}
              cooldownTicks={100}
              d3VelocityDecay={0.3}
              d3AlphaDecay={0.02}
              enableNodeDrag
              enableZoomInteraction
              enablePanInteraction
            />
            {/* Legend */}
            <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)]/80 px-3 py-2 backdrop-blur-sm">
              {FLEET_LEGEND.map(item => (
                <div key={item.label} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-[10px] text-[var(--muted)]">{item.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
