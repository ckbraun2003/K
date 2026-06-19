import { useRef, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ForceGraph2D from 'react-force-graph-2d'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'

type FGNode = { id?: string | number; [key: string]: unknown }

function healthColor(healthScore: number | undefined | null): string {
  if (healthScore == null) return '#8b8b93'
  if (healthScore >= 75) return '#22c55e'
  if (healthScore >= 50) return '#eab308'
  return '#ef4444'
}

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
      val: 3,
      color: healthColor(p.healthScore),
    })),
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
      <div ref={containerRef} className="flex-1 overflow-hidden">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            No projects registered. Go to Projects to add one.
          </div>
        ) : (
          <ForceGraph2D
            graphData={graphData}
            width={dims.width}
            height={dims.height}
            backgroundColor="#0a0a0f"
            nodeLabel="label"
            onNodeClick={(node: FGNode) => {
              if (node.id) navigate('project', node.id as string)
            }}
            enableNodeDrag
            enableZoomInteraction
            enablePanInteraction
          />
        )}
      </div>
    </div>
  )
}
