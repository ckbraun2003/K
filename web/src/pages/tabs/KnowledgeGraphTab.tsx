import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ForceGraph3D from 'react-force-graph-3d'
import type { GraphResponse, Run } from '@k/shared'
import { api } from '../../lib/api'
import GraphErrorBoundary from '../../components/GraphErrorBoundary'
import { navigate } from '../../lib/route'
import { onWsMessage } from '../../lib/ws'
import { dialogCard, overlayFade, sidePanel, fade, microLift, prefersReducedMotion } from '../../lib/motion'
import {
  DISPATCH_ACTIONS,
  GRAPH_LEGEND,
  GRAPH_BG,
  GRAPH_LINK_COLOR,
  GRAPH_WARMUP_TICKS,
  EMPTY_FORCE_GRAPH_DATA,
  configureGraphForces,
  smallFleetCameraZ,
  applyGraphLod,
  LOD_LOW_RES_THRESHOLD,
  type DispatchAction,
  type GraphNode,
  makeGraphUpdateHandler,
  nodeColor,
} from '../../lib/graph'
import { computeGraphLayout, type LayoutPosition } from '../../lib/graph-layout'
import { Icon } from '../../ui/Icon'
import { Button, IconButton } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { Input } from '../../ui/Field'

type GraphLink = {
  source: string | GraphNode
  target: string | GraphNode
  type?: string
}

const EMPTY: GraphResponse = {
  nodes: [],
  links: [],
  stale: true,
  status: 'idle',
  builtAt: null,
  nodeCount: 0,
  edgeCount: 0,
  error: null,
}

function formatBuiltAt(builtAt: number | null): string {
  if (!builtAt) return 'never built'
  const diff = Date.now() - builtAt
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'built just now'
  if (m < 60) return `built ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `built ${h}h ago`
  return `built ${Math.floor(h / 24)}d ago`
}

// Hardening fix (opus review, Minor #2): if the graph-layout worker hasn't resolved
// positions within this budget, the layout effect falls back to the synchronous
// path so the "Computing layout…" overlay can never hang on a stuck/silent worker.
const WORKER_WATCHDOG_MS = 4_000

interface Props {
  projectId: string
}

export default function KnowledgeGraphTab({ projectId }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<GraphResponse>({
    queryKey: ['graph', projectId],
    queryFn: () => api.projects.graph(projectId),
    retry: false,
    staleTime: 60_000,
  })

  const graph = data ?? EMPTY
  const building = graph.status === 'building'

  // Large-graph guardrail: above LOD_NODE_CAP nodes, render only the top-N most
  // connected (applyGraphLod) so the WebGL scene — and the layout below — never
  // has to handle thousands of meshes. Memoised on the raw graph arrays so a text
  // filter (which only narrows the visible subset) never re-caps or re-lays-out.
  const lod = useMemo(
    () => applyGraphLod(graph.nodes as unknown as GraphNode[], graph.links as unknown as GraphLink[]),
    [graph.nodes, graph.links],
  )

  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [filter, setFilter] = useState('')
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [action, setAction] = useState<DispatchAction>('investigate')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string; runId?: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(undefined)
  const [dims, setDims] = useState({ width: 800, height: 600 })
  // D1: gates the real graphData behind a two-phase mount — see
  // EMPTY_FORCE_GRAPH_DATA's doc comment in graph.ts for why (warmupTicks digests
  // headlessly & synchronously on mount, before configureGraphForces' ref-based
  // force-tuning could otherwise ever run first).
  const [forcesReady, setForcesReady] = useState(false)
  // D2 fix: bumped on a GraphErrorBoundary reset so the ForceGraph3D subtree gets a
  // fresh `key` (a truly new instance + imperative ref) and the two-phase-mount
  // effect below (keyed on it) re-arms — see handleGraphReset.
  const [mountGen, setMountGen] = useState(0)
  // D-134 (Round 3): precomputed force-layout positions, keyed by node id, produced
  // OFF the main thread by graph-layout.worker (or a synchronous fallback). Null while
  // the layout is still computing — the graph mounts on EMPTY until this fills in, so
  // the page never blocks on a headless warmup regardless of graph size.
  //
  // Hardening fix (opus review, Minor #1): positions are bound to the EXACT `lod`
  // they were computed for. Without this, a `lod` change (Refresh / WS graph_update
  // on an already-loaded graph) leaves the OLD positions map non-null for one render
  // — layoutReady would read true and the NEW node ids get looked up against the
  // stale map, reaching the canvas without fx/fy/fz for one frame. Gating readiness
  // on `layout.lod === lod` (referential identity — `lod` is memoised) closes that
  // window: the gate holds EMPTY until positions for the CURRENT lod land.
  const [layout, setLayout] = useState<{ lod: typeof lod; map: Map<string, { x: number; y: number; z: number }> } | null>(null)
  const layoutReady = layout != null && layout.lod === lod

  // Live: a graph_update for THIS project refreshes the graph (build done / went stale).
  useEffect(() => {
    return onWsMessage(makeGraphUpdateHandler(projectId, qc))
  }, [projectId, qc])

  // Auto-dismiss the transient dispatch notice.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6_000)
    return () => clearTimeout(t)
  }, [notice])

  const buildMutation = useMutation({
    mutationFn: () => api.projects.graphBuild(projectId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['graph', projectId] }),
  })

  // Single Build/Refresh entry point: guarded so a stray double-click can't POST twice.
  const handleBuild = useCallback(() => {
    if (buildMutation.isPending) return
    buildMutation.mutate()
  }, [buildMutation])

  const dispatchMutation = useMutation({
    mutationFn: ({ node, action }: { node: GraphNode; action: DispatchAction }) =>
      api.projects.graphDispatch(projectId, {
        nodeId: node.id,
        file: typeof node.file === 'string' ? node.file : undefined,
        action,
      }),
    onSuccess: (run: Run) => {
      setDispatchOpen(false)
      setNotice({ kind: 'ok', text: 'Agent dispatched.', runId: run.id })
    },
    onError: (err: unknown) => {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Dispatch failed.' })
    },
  })

  // Resize observer to fill container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        setDims({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // DF-2: 1-2 node graphs degenerate zoomToFit's bounding sphere and park the
  // camera inside the node mesh (GraphView already guards this the same way via
  // smallFleetCameraZ) — pin a fixed sane distance instead of fitting. durationMs=0
  // gives an instant snap (used for the one-shot fit-on-load below); the manual
  // "Fit (f)" button/shortcut keep their smooth 400ms animation.
  const didFitRef = useRef(false)
  const fit = useCallback(
    (durationMs: number) => {
      const z = smallFleetCameraZ(graph.nodes.length)
      if (z != null) graphRef.current?.cameraPosition({ x: 0, y: 0, z }, { x: 0, y: 0, z: 0 }, durationMs)
      else graphRef.current?.zoomToFit(durationMs)
    },
    [graph.nodes.length],
  )

  // Re-arm the fit-once latch when the node set changes (fresh build/rebuild), so a
  // meaningfully different graph gets re-framed — mirrors GraphView's didFitRef reset.
  // Also re-arms on a GraphErrorBoundary remount (mountGen): the fresh ForceGraph3D
  // instance opens on a default camera, so it needs its own one-shot fit too.
  useEffect(() => {
    didFitRef.current = false
  }, [graph.nodes.length, mountGen])

  // GraphErrorBoundary reset (D2 fix): the remounted ForceGraph3D is a brand-new
  // d3ForceLayout, so the two-phase mount (D1) must redo phase 1 — reset forcesReady
  // and bump mountGen so the effect below + the ForceGraph3D `key` both re-fire.
  const handleGraphReset = useCallback(() => {
    setForcesReady(false)
    setMountGen(g => g + 1)
  }, [])

  // 'f' key shortcut to fit view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'f') fit(400)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [fit])

  // D3: selecting a node opens the inspector panel only — no camera-fly. Free
  // zoom/orbit (and the auto-rotate below, once the panel closes) are how the
  // user reframes the view now instead of the camera jumping to the node.
  const handleNodeClick = useCallback((node: object) => {
    setSelected(node as GraphNode)
  }, [])

  // Apply collision + spacing forces once the graph has data (and whenever the node
  // set changes), so nodes don't overlap and edges rarely cross through nodes.
  // Two-phase mount (D1): the FIRST ForceGraph3D mount below is fed
  // EMPTY_FORCE_GRAPH_DATA (a trivial, instant digest) precisely so d3Force() — only
  // callable once the engine has mounted — is reachable here BEFORE the real data's
  // warmupTicks-driven digest ever runs; forcesReady then swaps the real data in.
  useEffect(() => {
    // Guard on real data: without this, this effect's mount pass fires while
    // `graph` is still the local EMPTY placeholder (0 nodes, pre-query-resolve) —
    // before the ForceGraph3D below (gated behind `hasData`) has ever mounted —
    // which would flip forcesReady true prematurely and defeat the two-phase
    // mount entirely (its real FIRST mount would get real data directly, since
    // forcesReady is already true by the time hasData flips on).
    if (graph.nodes.length === 0) return
    configureGraphForces(graphRef.current, { nodeSize: 5 })
    setForcesReady(true)
  }, [graph.nodes.length, mountGen])

  // D-134 (Round 3): compute the force layout OFF the main thread. On each new
  // (LOD-capped) dataset, hand the bare {id}/{source,target} shape to a Web Worker
  // that runs d3-force-3d to a bounded tick budget and posts back fixed positions;
  // the main thread then pins them as fx/fy/fz and mounts with warmupTicks=0 (below),
  // so the page NEVER runs the O(n log n) warmup synchronously. Falls back to a
  // bounded SYNCHRONOUS layout when Worker is unavailable (jsdom/tests/SSR), which is
  // also what keeps the mount testable. Re-runs only when the capped node/link set
  // changes — a text filter never re-lays-out.
  useEffect(() => {
    const nodes = lod.nodes
    const links = lod.links
    if (nodes.length === 0) {
      setLayout(null)
      return
    }
    // Reset while (re)computing → layoutReady (gated on `layout.lod === lod`) reads
    // false for the new `lod` even before this fires (the previous lod's `layout`
    // fails the identity check on its own), but clearing here too avoids holding a
    // stale map in state while the "Computing layout…" overlay shows and the graph
    // stays mounted on EMPTY (zero simulation) until positions for THIS lod arrive.
    setLayout(null)
    if (lod.capped) {
      // No silent truncation — record what the guardrail dropped.
      console.info(
        `KnowledgeGraphTab: large graph — laying out the top ${lod.shown} of ${lod.total} nodes (by degree).`,
      )
    }

    const layoutNodes = nodes.map(n => ({ id: n.id }))
    const layoutLinks = links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
    }))
    const opts = { ticks: GRAPH_WARMUP_TICKS, nodeSize: 5 }

    let cancelled = false
    // Hardening fix (opus review, Minor #2): a worker watchdog. If the worker
    // hasn't resolved positions for THIS lod within WORKER_WATCHDOG_MS, fall back
    // to the synchronous path — so a stuck/silent worker (one that never posts a
    // message and never fires onerror) can't leave the "Computing layout…" overlay
    // hung forever. Cleared as soon as positions resolve by any path, and in the
    // effect cleanup; guarded by `cancelled` so a watchdog that fires for a stale
    // lod (effect already re-ran) is a no-op.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const clearWatchdog = () => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog)
        watchdog = undefined
      }
    }
    const apply = (pos: LayoutPosition[]) => {
      clearWatchdog()
      if (cancelled) return
      const map = new Map<string, { x: number; y: number; z: number }>()
      for (const p of pos) map.set(p.id, { x: p.x, y: p.y, z: p.z })
      setLayout({ lod, map })
    }
    const runSync = () => apply(computeGraphLayout(layoutNodes, layoutLinks, opts))

    // Fallback: no Worker (jsdom/tests/SSR) → bounded synchronous layout.
    if (typeof Worker === 'undefined') {
      runSync()
      return
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('../../lib/graph-layout.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      // Worker construction unsupported here — degrade gracefully.
      runSync()
      return
    }
    worker.onmessage = (e: MessageEvent<LayoutPosition[]>) => {
      apply(e.data)
      worker.terminate()
    }
    worker.onerror = () => {
      // Worker threw (e.g. module load failed) — fall back so the graph still
      // renders instead of spinning on the overlay forever.
      clearWatchdog()
      if (!cancelled) runSync()
      worker.terminate()
    }
    worker.postMessage({ nodes: layoutNodes, links: layoutLinks, opts })
    watchdog = setTimeout(() => {
      watchdog = undefined
      if (cancelled) return
      worker.terminate()
      runSync()
    }, WORKER_WATCHDOG_MS)
    return () => {
      cancelled = true
      clearWatchdog()
      worker.terminate()
    }
  }, [lod])

  // D2: slow ambient auto-rotate around the graph center. react-force-graph-3d's
  // three.js TrackballControls have no built-in `autoRotate` (unlike OrbitControls),
  // so we drive the orbit ourselves: each frame, read the camera's CURRENT position
  // (not a fixed radius/angle) and nudge its azimuth via cameraPosition() — so
  // resuming after a user zoom/tilt never snaps back to some earlier framing.
  // Pauses on pointer-down/wheel (the idle-resume timer only arms on pointer-up/
  // cancel — never mid-drag — or after a wheel tick, so a sustained drag isn't
  // fought mid-orbit) and while the node inspector is open; never starts at all
  // under prefers-reduced-motion.
  //
  // Soft-crash fix (ui-adjustments Lane D): this effect MUST depend on mountGen —
  // a GraphErrorBoundary remount tears down the ForceGraph3D instance (graphRef
  // goes null, then points at a fresh instance), and without re-arming here the
  // stale loop from before the remount keeps calling camera methods against a
  // torn-down/null instance. requestAnimationFrame callbacks run OUTSIDE React's
  // render/commit cycle, so a throw inside tick() can NEVER be caught by
  // GraphErrorBoundary (error boundaries don't catch errors from async callbacks)
  // — it would otherwise escape straight past the boundary and blank the panel.
  // tick() therefore also null-guards the ref/camera AND wraps its body in
  // try/catch, cancelling the loop on any throw rather than risking a
  // loop-forever throw storm. NEVER call d3ReheatSimulation here (see
  // configureGraphForces' docblock — it crashes the 3D engine pre-digest).
  const selectedRef = useRef<GraphNode | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    // layoutReady gate (D-134): don't orbit before the worker/fallback has produced
    // positions — the graph is still mounted on EMPTY until then, so there is nothing
    // to rotate and the camera reads a degenerate scene.
    if (graph.nodes.length === 0 || !layoutReady || prefersReducedMotion()) return
    const el = containerRef.current
    if (!el) return

    const ANGULAR_SPEED = 0.05 // rad/s — a full revolution takes ~2 minutes
    const RESUME_DELAY_MS = 1500
    let rafId = 0
    let resumeTimer: ReturnType<typeof setTimeout> | undefined
    let lastTs: number | null = null
    let paused = false

    const tick = (ts: number) => {
      rafId = requestAnimationFrame(tick)
      try {
        if (paused || selectedRef.current) {
          lastTs = null
          return
        }
        if (lastTs == null) {
          lastTs = ts
          return
        }
        const dt = (ts - lastTs) / 1000
        lastTs = ts
        const fg = graphRef.current
        const cam = fg?.camera?.()
        // Bail on a torn-down/null instance (e.g. mid GraphErrorBoundary remount) —
        // this frame simply does nothing rather than touching a disposed engine.
        if (!fg || !cam) return
        const { x, y, z } = cam.position
        const radius = Math.hypot(x, z)
        if (radius < 1e-3) return // degenerate: camera sitting on the vertical axis
        const angle = Math.atan2(x, z) + ANGULAR_SPEED * dt
        fg.cameraPosition({ x: radius * Math.sin(angle), y, z: radius * Math.cos(angle) }, undefined, 0)
      } catch (err) {
        // A torn-down/disposed graph instance can throw here instead of just
        // returning a falsy camera — and because this runs outside React's
        // render/commit cycle, GraphErrorBoundary can never catch it. Cancel the
        // frame this tick just rescheduled (rafId was reassigned above) so a
        // transient failure stops the loop instead of throwing every frame
        // forever; the effect re-arms a fresh loop on the next mountGen bump.
        console.error('KnowledgeGraphTab: auto-rotate tick failed — cancelling the loop', err)
        cancelAnimationFrame(rafId)
      }
    }
    rafId = requestAnimationFrame(tick)

    const armResumeTimer = () => {
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => {
        paused = false
      }, RESUME_DELAY_MS)
    }
    // pointerdown pauses immediately and CLEARS any pending resume timer — a drag
    // held past RESUME_DELAY_MS must not have the idle-resume fire mid-drag and
    // fight TrackballControls while the user is still orbiting. The resume timer is
    // armed only once the drag actually ends; pointerup/pointercancel are listened
    // on window (not the container) since a drag can end outside it.
    const onPointerDown = () => {
      paused = true
      if (resumeTimer) {
        clearTimeout(resumeTimer)
        resumeTimer = undefined
      }
    }
    const onPointerUp = () => armResumeTimer()
    // wheel has no "held" state to fight — pause-then-idle-resume per tick is fine.
    const onWheel = () => {
      paused = true
      armResumeTimer()
    }
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    el.addEventListener('wheel', onWheel, { passive: true })

    return () => {
      cancelAnimationFrame(rafId)
      if (resumeTimer) clearTimeout(resumeTimer)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('wheel', onWheel)
    }
    // mountGen: re-arms this loop on a GraphErrorBoundary remount — see the
    // soft-crash-fix note above the effect for why this dep is load-bearing.
    // layoutReady: arms the loop only once positions have arrived (D-134).
  }, [graph.nodes.length, mountGen, layoutReady])

  const colorFn = useCallback((node: object) => nodeColor(node as GraphNode, filter), [filter])

  // Legend wiring (Impressive Wave Task 10 Step 6): only show entries whose
  // state is actually present among the currently-displayed nodes — an empty
  // graph, or one that's all-healthy, shouldn't advertise "Failing"/"Untested"
  // swatches nobody will ever see. Colour is computed with an EMPTY filter so
  // the legend reflects real node state, not the text-filter's dim-out effect.
  const visibleLegend = useMemo(() => {
    const present = new Set((graph.nodes as unknown as GraphNode[]).map(n => nodeColor(n, '')))
    return GRAPH_LEGEND.filter(item => present.has(item.color))
  }, [graph.nodes])

  const filteredData = useMemo(() => {
    const baseNodes = lod.nodes
    const baseLinks = lod.links
    // Merge the precomputed FIXED positions (fx/fy/fz) so the graph mounts on the
    // off-thread layout with zero main-thread simulation. Fresh node objects — never
    // mutate the React Query cache. While positions are still computing (or belong to
    // a stale `lod` — see the `layout` state doc comment) the render gate keeps EMPTY
    // mounted, so unpositioned nodes never reach the canvas.
    const positions = layout && layout.lod === lod ? layout.map : null
    const place = (n: GraphNode): GraphNode => {
      const p = positions?.get(n.id)
      return p ? { ...n, x: p.x, y: p.y, z: p.z, fx: p.x, fy: p.y, fz: p.z } : n
    }
    if (!filter) return { nodes: baseNodes.map(place), links: baseLinks }
    const q = filter.toLowerCase()
    const matchIds = new Set(
      baseNodes.filter(n => (n.label ?? n.id ?? '').toString().toLowerCase().includes(q)).map(n => n.id),
    )
    return {
      nodes: baseNodes.filter(n => matchIds.has(n.id)).map(place),
      links: baseLinks.filter(l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source
        const tgt = typeof l.target === 'object' ? l.target.id : l.target
        return matchIds.has(src as string) && matchIds.has(tgt as string)
      }),
    }
  }, [lod, filter, layout])

  const enrichment = selected?.enrichment
  // Canonical "do we have graph data" signal: the actually-rendered node array, so the
  // toolbar label and the empty-state branch can never disagree.
  const hasData = graph.nodes.length > 0
  // Export-failure: meta says a graph WAS built (ready + nodeCount > 0) but no
  // renderable nodes came back (graph.json missing/unreadable). Distinct from the
  // normal never-built empty state so the user knows to rebuild, not just build.
  const dataUnavailable = !hasData && graph.status === 'ready' && graph.nodeCount > 0

  return (
    <div className="flex h-full flex-col">
      {/* Controls bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <Input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter nodes…"
          className="w-48 px-2.5 py-1 text-xs"
        />
        <Button variant="glass" size="sm" onClick={() => fit(400)} title="Fit view (f)">
          Fit (f)
        </Button>
        <Button
          variant="glass"
          size="sm"
          onClick={handleBuild}
          disabled={building || buildMutation.isPending}
          title="Rebuild the knowledge graph"
        >
          {building ? 'Building…' : dataUnavailable ? 'Rebuild' : hasData ? 'Refresh' : 'Build graph'}
        </Button>
        <span className="font-mono text-[10px] text-muted" data-testid="kg-count-label">
          {filteredData.nodes.length} nodes · {filteredData.links.length} edges
        </span>
        {lod.capped && (
          <span
            data-testid="kg-lod-note"
            className="rounded bg-[var(--glass-3)] px-2 py-0.5 text-[10px] font-medium text-muted"
            title={`Large graph: showing the ${lod.shown} most-connected of ${lod.total} nodes so rendering stays responsive.`}
          >
            top {lod.shown} of {lod.total}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {building && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
              <Spinner size={14} className="text-accent" />
              Building…
            </span>
          )}
          <span className="font-mono text-[10px] text-muted">{formatBuiltAt(graph.builtAt)}</span>
          {graph.status === 'error' && graph.error && (
            <span
              className="rounded bg-red/15 px-2 py-0.5 text-[11px] font-medium text-red"
              title={graph.error}
            >
              build failed
            </span>
          )}
          {graph.stale && graph.status !== 'building' && (
            <span className="rounded bg-amber/15 px-2 py-0.5 text-[11px] font-medium text-amber">
              stale
            </span>
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Graph canvas */}
        <div ref={containerRef} className="relative flex-1">
          {isLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
              <Spinner size={20} />
              Loading graph…
            </div>
          ) : !hasData ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
              <span>
                {graph.status === 'error'
                  ? 'Graph build failed.'
                  : dataUnavailable
                    ? 'Graph data unavailable — rebuild.'
                    : 'No graph data yet.'}
              </span>
              {graph.status === 'error' && graph.error && (
                <code className="max-w-md break-all font-mono text-[11px] text-red">{graph.error}</code>
              )}
              {dataUnavailable && (
                <span className="max-w-md text-center text-[11px] text-amber">
                  Build reported {graph.nodeCount} nodes but no graph data could be loaded. Rebuild to regenerate it.
                </span>
              )}
              <Button variant="primary" size="sm" onClick={handleBuild} disabled={building || buildMutation.isPending}>
                {building ? 'Building…' : dataUnavailable ? 'Rebuild graph' : 'Build graph'}
              </Button>
            </div>
          ) : (
            <>
              <GraphErrorBoundary onReset={handleGraphReset}>
                <ForceGraph3D
                  key={mountGen}
                  ref={graphRef}
                  // Mount on the precomputed FIXED positions once BOTH the two-phase
                  // forces are tuned (forcesReady) AND the off-thread layout is in
                  // (layoutReady). Until then, EMPTY — zero nodes, nothing to warm.
                  graphData={forcesReady && layoutReady ? filteredData : EMPTY_FORCE_GRAPH_DATA}
                  width={dims.width}
                  height={dims.height}
                  backgroundColor={GRAPH_BG}
                  nodeLabel="label"
                  nodeColor={colorFn}
                  nodeVal={5}
                  nodeOpacity={0.9}
                  // Large graphs drop to coarser spheres to cut per-node mesh cost.
                  nodeResolution={lod.shown > LOD_LOW_RES_THRESHOLD ? 8 : 16}
                  linkColor={() => GRAPH_LINK_COLOR}
                  linkWidth={1}
                  linkOpacity={0.5}
                  onNodeClick={handleNodeClick}
                  // D-134: positions are precomputed OFF the main thread and pinned as
                  // fx/fy/fz, so the on-mount simulation does ZERO work — no headless
                  // warmup (the old freeze cause), no cooldown animation. The layout
                  // budget now lives in the worker (GRAPH_WARMUP_TICKS ticks there).
                  warmupTicks={0}
                  cooldownTicks={0}
                  d3VelocityDecay={0.3}
                  d3AlphaDecay={0.02}
                  enableNodeDrag
                  onEngineStop={() => {
                    // First digest once real (positioned) data swaps in: fit-to-view
                    // once, instantly. Gated on forcesReady so the phase-1 empty-data
                    // mount's own onEngineStop (cooldownTicks=0 fires even at 0 nodes)
                    // can't consume the one-shot flag before real data loads.
                    if (forcesReady && layoutReady && !didFitRef.current) {
                      didFitRef.current = true
                      fit(0)
                    }
                  }}
                />
              </GraphErrorBoundary>
              {/* Layout overlay: shown while the worker (or fallback) computes fixed
                  positions. pointer-events-none so the page stays fully interactive —
                  the graph is mounted on EMPTY behind it, nothing to block. */}
              {!layoutReady && (
                <div
                  data-testid="kg-layout-overlay"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <div className="flex items-center gap-2 glass-overlay rounded-panel px-4 py-2 text-sm text-muted">
                    <Spinner size={16} />
                    <span>Computing layout…</span>
                  </div>
                </div>
              )}
              {/* Legend — only the states actually present in this graph (Step 6). */}
              {visibleLegend.length > 0 && (
                <div data-testid="kg-legend" className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 glass-overlay px-3 py-2">
                  {visibleLegend.map(item => (
                    <div key={item.label} className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-[10px] text-muted">{item.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Node inspector panel */}
        <AnimatePresence>
        {selected && (
          <motion.div
            key="inspector"
            variants={sidePanel} initial="hidden" animate="visible" exit="exit"
            // Left hairline intentionally inherits the lighter --glass-tier-border
            // color (from .glass-overlay) to read as a glass panel edge — not a bug.
            className="glass-overlay absolute right-0 top-0 flex h-full w-80 flex-col overflow-y-auto rounded-none border-y-0 border-r-0 border-l p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Node</span>
              <IconButton name="close" variant="ghost" label="Close panel" onClick={() => setSelected(null)} />
            </div>

            <div className="mt-3 space-y-2">
              <div>
                <p className="text-[10px] text-muted">Label</p>
                <p className="text-sm font-medium text-text">{selected.label ?? selected.id}</p>
              </div>
              {selected.type && (
                <div>
                  <p className="text-[10px] text-muted">Type</p>
                  <p className="font-mono text-xs text-text">{selected.type}</p>
                </div>
              )}
              {selected.group && (
                <div>
                  <p className="text-[10px] text-muted">Group</p>
                  <p className="font-mono text-xs text-text">{selected.group}</p>
                </div>
              )}
              {typeof selected.file === 'string' && (
                <div>
                  <p className="text-[10px] text-muted">File</p>
                  <p className="break-all font-mono text-[10px] text-text">{selected.file}</p>
                </div>
              )}
              <div>
                <p className="text-[10px] text-muted">ID</p>
                <p className="break-all font-mono text-[10px] text-muted">{selected.id}</p>
              </div>
            </div>

            {/* Enrichment facts */}
            {enrichment && (enrichment.lastRun || enrichment.findings?.length || enrichment.inBible) && (
              <div className="mt-4 space-y-3 border-t border-border pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Insights</p>

                {enrichment.lastRun && (
                  <div>
                    <p className="text-[10px] text-muted">Last touched by run</p>
                    <button
                      onClick={() => navigate('project', projectId, 'runs')}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-accent-hover transition-colors hover:text-text"
                      title={`${enrichment.lastRun.status} · ${new Date(enrichment.lastRun.createdAt).toLocaleString()}`}
                    >
                      {enrichment.lastRun.runId.slice(0, 8)} · {enrichment.lastRun.status}
                      <Icon name="external" size={14} />
                    </button>
                  </div>
                )}

                {enrichment.findings && enrichment.findings.length > 0 && (
                  <div>
                    <p className="mb-1 text-[10px] text-muted">Verification findings</p>
                    <ul className="space-y-1">
                      {enrichment.findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                          <span
                            className={
                              f.severity === 'critical'
                                ? 'text-red'
                                : f.severity === 'warn'
                                  ? 'text-amber'
                                  : 'text-muted'
                            }
                          >
                            ●
                          </span>
                          <span className="text-text">{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {enrichment.inBible && (
                  <div className="inline-flex items-center gap-1 rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-hover">
                    <Icon name="docs" size={14} /> In bible
                  </div>
                )}
              </div>
            )}

            <div className="mt-auto space-y-2 pt-4">
              <motion.button
                {...microLift}
                onClick={() => navigate('project', projectId, 'runs')}
                className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90"
              >
                View in Runs
              </motion.button>
              <motion.button
                {...microLift}
                onClick={() => {
                  setAction('investigate')
                  dispatchMutation.reset()
                  setDispatchOpen(true)
                }}
                className="w-full rounded-lg border border-[var(--glass-tier-border)] bg-[var(--glass-3)] px-3 py-2 text-xs font-semibold text-text transition-colors hover:bg-[var(--glass-hover)]"
              >
                Dispatch Agent
              </motion.button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Transient dispatch notice */}
        <AnimatePresence>
        {notice && (
          <motion.div
            key="notice"
            variants={fade} initial="hidden" animate="visible" exit="exit"
            className={`absolute bottom-3 right-3 z-40 flex items-center gap-3 rounded-lg border px-3 py-2 text-xs shadow-lg ${
              notice.kind === 'ok'
                ? 'border-[var(--glass-tier-border)] bg-[var(--glass-3)] text-text'
                : 'border-red/40 bg-red/10 text-red'
            }`}
            role="status"
          >
            <span>{notice.text}</span>
            {notice.runId && (
              <button
                onClick={() => navigate('project', projectId, 'runs')}
                className="inline-flex items-center gap-1 font-semibold text-accent-hover transition-colors hover:text-text"
              >
                View run
                <Icon name="external" size={14} />
              </button>
            )}
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Dispatch confirm-card modal */}
      <AnimatePresence>
      {dispatchOpen && (
        <motion.div
          variants={overlayFade} initial="hidden" animate="visible" exit="exit"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => {
            if (e.target === e.currentTarget && !dispatchMutation.isPending) setDispatchOpen(false)
          }}
        >
          {selected && (
          <motion.div
            variants={dialogCard} initial="hidden" animate="visible" exit="exit"
            className="glass-overlay flex w-full max-w-md flex-col gap-4 p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dispatch-title"
          >
            <div>
              <h2 id="dispatch-title" className="text-sm font-semibold text-text">
                Dispatch agent
              </h2>
              <p className="mt-1 break-all font-mono text-[11px] text-muted">
                {typeof selected.file === 'string' ? selected.file : selected.label ?? selected.id}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {DISPATCH_ACTIONS.map(a => (
                <label
                  key={a.action}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
                    action === a.action
                      ? 'border-[var(--glass-active-edge)] bg-[var(--glass-active)]'
                      : 'border-[var(--glass-tier-border)] bg-[var(--glass-2)] hover:bg-[var(--glass-hover)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="dispatch-action"
                    value={a.action}
                    checked={action === a.action}
                    onChange={() => setAction(a.action)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="block text-xs font-medium text-text">{a.label}</span>
                    <span className="block text-[11px] text-muted">{a.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {dispatchMutation.isError && (
              <p className="text-[11px] text-red">
                {dispatchMutation.error instanceof Error ? dispatchMutation.error.message : 'Dispatch failed.'}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDispatchOpen(false)} disabled={dispatchMutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={dispatchMutation.isPending}
                onClick={() => {
                  if (!selected) return
                  dispatchMutation.mutate({ node: selected, action })
                }}
              >
                Dispatch
              </Button>
            </div>
          </motion.div>
          )}
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
