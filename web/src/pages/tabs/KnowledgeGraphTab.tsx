import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ForceGraph2D from 'react-force-graph-2d'
import type { GraphResponse, Run } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { onWsMessage } from '../../lib/ws'
import { dialogCard, overlayFade, sidePanel, fade, microLift, prefersReducedMotion } from '../../lib/motion'
import {
  DISPATCH_ACTIONS,
  GRAPH_LEGEND,
  GRAPH_BG,
  GRAPH_LINK_COLOR,
  drawGraphNode,
  paintNodePointerArea,
  configureGraphForces,
  type DispatchAction,
  type GraphNode,
  makeGraphUpdateHandler,
  nodeColor,
} from '../../lib/graph'

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

  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [filter, setFilter] = useState('')
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [action, setAction] = useState<DispatchAction>('investigate')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string; runId?: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(undefined)
  const [dims, setDims] = useState({ width: 800, height: 600 })

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

  // 'f' key shortcut to fit view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'f') graphRef.current?.zoomToFit(400)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleNodeClick = useCallback((node: object) => {
    const n = node as GraphNode & { x?: number; y?: number }
    setSelected(n)
    // Smoothly centre + zoom to the clicked node (respect reduced-motion).
    if (typeof n.x === 'number' && typeof n.y === 'number') {
      const ms = prefersReducedMotion() ? 0 : 400
      graphRef.current?.centerAt(n.x, n.y, ms)
      graphRef.current?.zoom(2.5, ms)
    }
  }, [])

  // Apply collision + spacing forces once the graph has data (and whenever the node
  // set changes), so nodes don't overlap and edges rarely cross through nodes.
  useEffect(() => {
    configureGraphForces(graphRef.current, { nodeSize: 5 })
  }, [graph.nodes.length])

  const colorFn = useCallback((node: object) => nodeColor(node as GraphNode, filter), [filter])

  const filteredData = useMemo(() => {
    const nodes = graph.nodes as unknown as GraphNode[]
    const links = graph.links as unknown as GraphLink[]
    if (!filter) return { nodes, links }
    const q = filter.toLowerCase()
    const matchIds = new Set(
      nodes.filter(n => (n.label ?? n.id ?? '').toString().toLowerCase().includes(q)).map(n => n.id),
    )
    return {
      nodes: nodes.filter(n => matchIds.has(n.id)),
      links: links.filter(l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source
        const tgt = typeof l.target === 'object' ? l.target.id : l.target
        return matchIds.has(src as string) && matchIds.has(tgt as string)
      }),
    }
  }, [graph.nodes, graph.links, filter])

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
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter nodes…"
          className="w-48 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2.5 py-1 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={() => graphRef.current?.zoomToFit(400)}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          title="Fit view (f)"
        >
          Fit (f)
        </button>
        <button
          onClick={handleBuild}
          disabled={building || buildMutation.isPending}
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2.5 py-1 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Rebuild the knowledge graph"
        >
          {building ? 'Building…' : dataUnavailable ? 'Rebuild' : hasData ? 'Refresh' : 'Build graph'}
        </button>
        <span className="font-mono text-[10px] text-[var(--muted)]">
          {graph.nodes.length} nodes · {graph.links.length} edges
        </span>
        <div className="ml-auto flex items-center gap-2">
          {building && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)]">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Building…
            </span>
          )}
          <span className="font-mono text-[10px] text-[var(--muted)]">{formatBuiltAt(graph.builtAt)}</span>
          {graph.status === 'error' && graph.error && (
            <span
              className="rounded bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-400"
              title={graph.error}
            >
              build failed
            </span>
          )}
          {graph.stale && graph.status !== 'building' && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
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
            <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
              Loading graph…
            </div>
          ) : !hasData ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--muted)]">
              <span>
                {graph.status === 'error'
                  ? 'Graph build failed.'
                  : dataUnavailable
                    ? 'Graph data unavailable — rebuild.'
                    : 'No graph data yet.'}
              </span>
              {graph.status === 'error' && graph.error && (
                <code className="max-w-md break-all font-mono text-[11px] text-red-400">{graph.error}</code>
              )}
              {dataUnavailable && (
                <span className="max-w-md text-center text-[11px] text-amber-400">
                  Build reported {graph.nodeCount} nodes but no graph data could be loaded. Rebuild to regenerate it.
                </span>
              )}
              <button
                onClick={handleBuild}
                disabled={building || buildMutation.isPending}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {building ? 'Building…' : dataUnavailable ? 'Rebuild graph' : 'Build graph'}
              </button>
            </div>
          ) : (
            <>
              <ForceGraph2D
                ref={graphRef}
                graphData={filteredData}
                width={dims.width}
                height={dims.height}
                backgroundColor={GRAPH_BG}
                nodeLabel="label"
                nodeRelSize={5}
                linkColor={() => GRAPH_LINK_COLOR}
                linkWidth={1.6}
                nodeCanvasObject={(node, ctx, scale) => drawGraphNode(node, ctx, scale, colorFn(node), 5)}
                nodePointerAreaPaint={(node, color, ctx) => paintNodePointerArea(node, ctx, color, 5)}
                onNodeClick={handleNodeClick}
                cooldownTicks={100}
                d3VelocityDecay={0.3}
                d3AlphaDecay={0.02}
                enableNodeDrag
                enableZoomInteraction
                enablePanInteraction
              />
              {/* Legend */}
              <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)]/80 px-3 py-2 backdrop-blur-sm">
                {GRAPH_LEGEND.map(item => (
                  <div key={item.label} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-[10px] text-[var(--muted)]">{item.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Node inspector panel */}
        <AnimatePresence>
        {selected && (
          <motion.div
            key="inspector"
            variants={sidePanel} initial="hidden" animate="visible" exit="exit"
            // Left hairline intentionally inherits the lighter --glass-border color
            // (from .glass) to read as a glass panel edge — not a bug.
            className="glass absolute right-0 top-0 flex h-full w-80 flex-col overflow-y-auto border-y-0 border-r-0 border-l p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Node</span>
              <button
                onClick={() => setSelected(null)}
                className="text-[var(--muted)] transition-colors hover:text-[var(--text)]"
                aria-label="Close panel"
              >
                ✕
              </button>
            </div>

            <div className="mt-3 space-y-2">
              <div>
                <p className="text-[10px] text-[var(--muted)]">Label</p>
                <p className="text-sm font-medium text-[var(--text)]">{selected.label ?? selected.id}</p>
              </div>
              {selected.type && (
                <div>
                  <p className="text-[10px] text-[var(--muted)]">Type</p>
                  <p className="font-mono text-xs text-[var(--text)]">{selected.type}</p>
                </div>
              )}
              {selected.group && (
                <div>
                  <p className="text-[10px] text-[var(--muted)]">Group</p>
                  <p className="font-mono text-xs text-[var(--text)]">{selected.group}</p>
                </div>
              )}
              {typeof selected.file === 'string' && (
                <div>
                  <p className="text-[10px] text-[var(--muted)]">File</p>
                  <p className="break-all font-mono text-[10px] text-[var(--text)]">{selected.file}</p>
                </div>
              )}
              <div>
                <p className="text-[10px] text-[var(--muted)]">ID</p>
                <p className="break-all font-mono text-[10px] text-[var(--muted)]">{selected.id}</p>
              </div>
            </div>

            {/* Enrichment facts */}
            {enrichment && (enrichment.lastRun || enrichment.findings?.length || enrichment.inBible) && (
              <div className="mt-4 space-y-3 border-t border-[var(--border)] pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Insights</p>

                {enrichment.lastRun && (
                  <div>
                    <p className="text-[10px] text-[var(--muted)]">Last touched by run</p>
                    <button
                      onClick={() => navigate('project', projectId, 'runs')}
                      className="font-mono text-[11px] text-[var(--accent-hover)] transition-colors hover:text-[var(--text)]"
                      title={`${enrichment.lastRun.status} · ${new Date(enrichment.lastRun.createdAt).toLocaleString()}`}
                    >
                      {enrichment.lastRun.runId.slice(0, 8)} · {enrichment.lastRun.status} ↗
                    </button>
                  </div>
                )}

                {enrichment.findings && enrichment.findings.length > 0 && (
                  <div>
                    <p className="mb-1 text-[10px] text-[var(--muted)]">Verification findings</p>
                    <ul className="space-y-1">
                      {enrichment.findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                          <span
                            className={
                              f.severity === 'critical'
                                ? 'text-red-400'
                                : f.severity === 'warn'
                                  ? 'text-amber-400'
                                  : 'text-[var(--muted)]'
                            }
                          >
                            ●
                          </span>
                          <span className="text-[var(--text)]">{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {enrichment.inBible && (
                  <div className="inline-flex items-center gap-1 rounded bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent-hover)]">
                    📖 In bible
                  </div>
                )}
              </div>
            )}

            <div className="mt-auto space-y-2 pt-4">
              <motion.button
                {...microLift}
                onClick={() => navigate('project', projectId, 'runs')}
                className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90"
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
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)]"
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
                ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]'
                : 'border-red-500/40 bg-red-500/10 text-red-300'
            }`}
            role="status"
          >
            <span>{notice.text}</span>
            {notice.runId && (
              <button
                onClick={() => navigate('project', projectId, 'runs')}
                className="font-semibold text-[var(--accent-hover)] transition-colors hover:text-[var(--text)]"
              >
                View run ↗
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
            className="glass-strong flex w-full max-w-md flex-col gap-4 rounded-xl p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dispatch-title"
          >
            <div>
              <h2 id="dispatch-title" className="text-sm font-semibold text-[var(--text)]">
                Dispatch agent
              </h2>
              <p className="mt-1 break-all font-mono text-[11px] text-[var(--muted)]">
                {typeof selected.file === 'string' ? selected.file : selected.label ?? selected.id}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {DISPATCH_ACTIONS.map(a => (
                <label
                  key={a.action}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
                    action === a.action
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="dispatch-action"
                    value={a.action}
                    checked={action === a.action}
                    onChange={() => setAction(a.action)}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-xs font-medium text-[var(--text)]">{a.label}</span>
                    <span className="block text-[11px] text-[var(--muted)]">{a.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {dispatchMutation.isError && (
              <p className="text-[11px] text-red-400">
                {dispatchMutation.error instanceof Error ? dispatchMutation.error.message : 'Dispatch failed.'}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDispatchOpen(false)}
                disabled={dispatchMutation.isPending}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!selected) return
                  dispatchMutation.mutate({ node: selected, action })
                }}
                disabled={dispatchMutation.isPending}
                className="flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {dispatchMutation.isPending && (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                )}
                Dispatch
              </button>
            </div>
          </motion.div>
          )}
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
