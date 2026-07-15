import { useRef, useEffect, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import ForceGraph3D from 'react-force-graph-3d'
import type { Project } from '@k/shared'
import { api } from '../../lib/api'
import GraphErrorBoundary from '../../components/GraphErrorBoundary'
import { navigate } from '../../lib/route'
import { GRAPH_BG, configureGraphForces, smallFleetCameraZ } from '../../lib/graph'
import { healthRubric } from '../../lib/health'
import { GlassPanel } from '../../ui/GlassPanel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'

type FGNode = { id?: string | number; color?: string; [key: string]: unknown }

function healthColor(healthScore: number | undefined | null): string {
  return healthRubric(healthScore ?? null).hex
}

// Swatches derive from the single healthRubric (SEAMS LOW-6) so a threshold/hex
// change lands in one place; labels name the canonical 75/50 bands.
const FLEET_LEGEND: { color: string; label: string }[] = [
  { color: healthRubric(75).hex, label: 'Healthy (≥75)' },
  { color: healthRubric(50).hex, label: 'At risk (≥50)' },
  { color: healthRubric(0).hex, label: 'Failing (<50)' },
  { color: healthRubric(null).hex, label: 'Unverified' },
]

export default function GraphView() {
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
    refetchInterval: 30_000,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(undefined)
  const [dims, setDims] = useState({ width: 1200, height: 700 })
  // Auto-fit ONCE per rendered graph. Without a fit the 3D camera opens on a
  // default frustum where — with only a few widely-spaced project nodes — just one
  // node lands in-viewport (F-043). Reset the latch when the project set changes so
  // a freshly loaded fleet re-fits, but a user's later zoom/pan is never yanked.
  const didFitRef = useRef(false)

  // DF-2: 1-2 node fleets degenerate zoomToFit's bounding sphere and park the
  // camera inside the node mesh — pin a fixed sane distance instead of fitting.
  const fit = useCallback(() => {
    const z = smallFleetCameraZ(projects.length)
    if (z != null) graphRef.current?.cameraPosition({ x: 0, y: 0, z }, { x: 0, y: 0, z: 0 }, 400)
    else graphRef.current?.zoomToFit(400, 40)
  }, [projects.length])

  useEffect(() => {
    didFitRef.current = false
  }, [projects.length])

  // Fit-view keyboard shortcut (parity with the Knowledge-Graph tab's 'f').
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'f') fit()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [fit])

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

  // Space nodes out + prevent overlap once the project set is known.
  useEffect(() => {
    configureGraphForces(graphRef.current, { nodeSize: 7 })
  }, [projects.length])

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
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <h2 className="text-title text-text">Fleet Graph</h2>
        <span className="ml-2 text-caption text-muted">
          <span className="mono tabular-nums">{projects.length}</span> project{projects.length === 1 ? '' : 's'}
        </span>
        {projects.length > 0 && (
          <Button
            variant="glass"
            size="sm"
            onClick={fit}
            data-testid="fleet-graph-fit"
            title="Fit view (f)"
            className="ml-auto"
          >
            Fit (f)
          </Button>
        )}
      </div>

      {/* Graph */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon="projects" headline="No projects registered." hint="Go to Projects to add one." />
          </div>
        ) : (
          <>
            <GraphErrorBoundary>
              <ForceGraph3D
                ref={graphRef}
                graphData={graphData}
                width={dims.width}
                height={dims.height}
                backgroundColor={GRAPH_BG}
                nodeLabel="label"
                nodeColor={(n: FGNode) => (n.color as string) ?? healthRubric(null).hex}
                nodeVal={7}
                nodeOpacity={0.9}
                nodeResolution={16}
                onNodeClick={(node: FGNode) => {
                  if (node.id) navigate('project', node.id as string)
                }}
                cooldownTicks={100}
                d3VelocityDecay={0.3}
                d3AlphaDecay={0.02}
                enableNodeDrag
                onEngineStop={() => {
                  // Auto-fit once the force layout settles, so the whole fleet is
                  // framed on first load (guarded so a later re-settle after a
                  // user pan/zoom doesn't fight them).
                  if (!didFitRef.current) {
                    didFitRef.current = true
                    fit()
                  }
                }}
              />
            </GraphErrorBoundary>
            {/* Legend — the only floating overlay on this canvas, hence glass-overlay.
                (GraphView has no node-inspector panel: a click navigates straight to
                the project page. DelegationTree's NodeDetail is the actual "inspector"
                the design brief means by that term.) */}
            <GlassPanel
              tier="overlay"
              className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 px-3 py-2"
            >
              {FLEET_LEGEND.map(item => (
                <div key={item.label} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-micro text-muted">{item.label}</span>
                </div>
              ))}
            </GlassPanel>
          </>
        )}
      </div>
    </div>
  )
}
