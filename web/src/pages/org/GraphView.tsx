import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import ForceGraph3D from 'react-force-graph-3d'
import type { Project } from '@k/shared'
import { api } from '../../lib/api'
import GraphErrorBoundary from '../../components/GraphErrorBoundary'
import { navigate } from '../../lib/route'
import {
  GRAPH_BG,
  GRAPH_WARMUP_TICKS,
  EMPTY_FORCE_GRAPH_DATA,
  configureGraphForces,
  smallFleetCameraZ,
} from '../../lib/graph'
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
  // D1 (ui-adjustments): gates the real graphData behind a two-phase mount — see
  // EMPTY_FORCE_GRAPH_DATA's doc comment in graph.ts for why (warmupTicks digests
  // headlessly & synchronously on mount, before configureGraphForces' ref-based
  // force-tuning could otherwise ever run first).
  const [forcesReady, setForcesReady] = useState(false)
  // D2 fix: bumped on a GraphErrorBoundary reset so the ForceGraph3D subtree gets a
  // fresh `key` (a truly new instance + imperative ref) and the two-phase-mount
  // effect below (keyed on it) re-arms — see handleGraphReset.
  const [mountGen, setMountGen] = useState(0)

  // DF-2: 1-2 node fleets degenerate zoomToFit's bounding sphere and park the
  // camera inside the node mesh — pin a fixed sane distance instead of fitting.
  const fit = useCallback(() => {
    const z = smallFleetCameraZ(projects.length)
    if (z != null) graphRef.current?.cameraPosition({ x: 0, y: 0, z }, { x: 0, y: 0, z: 0 }, 400)
    else graphRef.current?.zoomToFit(400, 40)
  }, [projects.length])

  // Also re-arms on a GraphErrorBoundary remount (mountGen): the fresh ForceGraph3D
  // instance opens on a default camera, so it needs its own one-shot fit too.
  useEffect(() => {
    didFitRef.current = false
  }, [projects.length, mountGen])

  // GraphErrorBoundary reset (D2 fix): the remounted ForceGraph3D is a brand-new
  // d3ForceLayout, so the two-phase mount (D1) must redo phase 1 — reset forcesReady
  // and bump mountGen so the effect below + the ForceGraph3D `key` both re-fire.
  const handleGraphReset = useCallback(() => {
    setForcesReady(false)
    setMountGen(g => g + 1)
  }, [])

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

  // Space nodes out + prevent overlap once the project set is known. Two-phase
  // mount (D1): the FIRST ForceGraph3D mount below is fed EMPTY_FORCE_GRAPH_DATA
  // (a trivial, instant digest) precisely so d3Force() — only callable once the
  // engine has mounted — is reachable here BEFORE the real data's
  // warmupTicks-driven digest ever runs; forcesReady then swaps the real data in.
  useEffect(() => {
    // Guard on real data: without this, this effect's mount pass fires while
    // `projects` is still `[]` (pre-query-resolve) — before the ForceGraph3D below
    // (gated behind `projects.length === 0`) has ever mounted — which would flip
    // forcesReady true prematurely and defeat the two-phase mount entirely (its
    // real FIRST mount would get real data directly, since forcesReady is already
    // true by the time the fleet actually has projects).
    if (projects.length === 0) return
    configureGraphForces(graphRef.current, { nodeSize: 7 })
    setForcesReady(true)
  }, [projects.length, mountGen])

  // Memoized: react-kapsule diffs props by REFERENCE (prevProps[p] !== props[p]),
  // so an un-memoized object literal here would be "new" on every render — and
  // with warmupTicks now driving the initial layout (D1), that would re-run the
  // full headless pre-settle on every unrelated re-render, not just when the
  // project set actually changes.
  const graphData = useMemo(
    () => ({
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
    }),
    [projects],
  )

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
            <GraphErrorBoundary onReset={handleGraphReset}>
              <ForceGraph3D
                key={mountGen}
                ref={graphRef}
                graphData={forcesReady ? graphData : EMPTY_FORCE_GRAPH_DATA}
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
                warmupTicks={GRAPH_WARMUP_TICKS}
                cooldownTicks={0}
                d3VelocityDecay={0.3}
                d3AlphaDecay={0.02}
                enableNodeDrag
                onEngineStop={() => {
                  // Auto-fit once the force layout settles, so the whole fleet is
                  // framed on first load (guarded so a later re-settle after a
                  // user pan/zoom doesn't fight them). forcesReady also guards the
                  // phase-1 empty-data mount's own onEngineStop (cooldownTicks=0
                  // fires even at 0 nodes) from consuming the one-shot flag early.
                  if (forcesReady && !didFitRef.current) {
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
