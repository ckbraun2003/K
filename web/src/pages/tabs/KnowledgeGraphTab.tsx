import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ForceGraph2D } from 'react-force-graph'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'

type GraphNode = {
  id: string
  label?: string
  type?: string
  group?: string
  [key: string]: unknown
}

type GraphLink = {
  source: string | GraphNode
  target: string | GraphNode
  type?: string
}

type GraphData = {
  nodes: GraphNode[]
  links: GraphLink[]
  stale: boolean
}

function nodeColor(node: GraphNode, filter: string): string {
  const matches =
    !filter || (node.label ?? node.id ?? '').toLowerCase().includes(filter.toLowerCase())
  if (!matches) return '#3a3a44'
  if (node.type === 'error' || node.group === 'failing') return '#ef4444'
  if (node.group === 'untested') return '#eab308'
  return '#6366f1'
}

interface Props {
  projectId: string
}

export default function KnowledgeGraphTab({ projectId }: Props) {
  const { data: rawGraph, isLoading } = useQuery<GraphData>({
    queryKey: ['graph', projectId],
    queryFn: () => api.projects.graph(projectId) as Promise<GraphData>,
    retry: false,
    staleTime: 60_000,
  })

  const graph = rawGraph ?? { nodes: [], links: [], stale: true }

  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [filter, setFilter] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(undefined)
  const [dims, setDims] = useState({ width: 800, height: 600 })

  // Resize observer to fill container
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

  // 'f' key shortcut to fit view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'f') {
        graphRef.current?.zoomToFit(400)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleNodeClick = useCallback((node: object) => {
    setSelected(node as GraphNode)
  }, [])

  const colorFn = useCallback(
    (node: object) => nodeColor(node as GraphNode, filter),
    [filter],
  )

  const filteredData = (() => {
    if (!filter) return { nodes: graph.nodes, links: graph.links }
    const q = filter.toLowerCase()
    const matchIds = new Set(
      graph.nodes
        .filter(n => ((n as GraphNode).label ?? (n as GraphNode).id ?? '').toString().toLowerCase().includes(q))
        .map(n => (n as GraphNode).id),
    )
    return {
      nodes: graph.nodes.filter(n => matchIds.has((n as GraphNode).id)),
      links: graph.links.filter(l => {
        const src = typeof (l as { source: unknown }).source === 'object'
          ? ((l as { source: GraphNode }).source).id
          : (l as { source: unknown }).source
        const tgt = typeof (l as { target: unknown }).target === 'object'
          ? ((l as { target: GraphNode }).target).id
          : (l as { target: unknown }).target
        return matchIds.has(src as string) && matchIds.has(tgt as string)
      }),
    }
  })()

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
        <span className="font-mono text-[10px] text-[var(--muted)]">
          {graph.nodes.length} nodes · {graph.links.length} edges
        </span>
        {graph.stale && (
          <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
            Index stale — run npx gitnexus analyze
          </span>
        )}
      </div>

      {/* Main area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Graph canvas */}
        <div ref={containerRef} className="flex-1">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
              Loading graph…
            </div>
          ) : graph.nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--muted)]">
              <span>No graph data.</span>
              <code className="font-mono text-xs">Run `npx gitnexus analyze` in this project to index it.</code>
            </div>
          ) : (
            <ForceGraph2D
              ref={graphRef}
              graphData={filteredData}
              width={dims.width}
              height={dims.height}
              backgroundColor="#0a0a0f"
              nodeLabel="label"
              nodeColor={colorFn}
              onNodeClick={handleNodeClick}
              enableNodeDrag
              enableZoomInteraction
              enablePanInteraction
            />
          )}
        </div>

        {/* Node inspector panel */}
        {selected && (
          <div className="absolute right-0 top-0 flex h-full w-80 flex-col border-l border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                Node
              </span>
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
                  <p className="font-mono text-[10px] text-[var(--text)] break-all">{selected.file}</p>
                </div>
              )}
              <div>
                <p className="text-[10px] text-[var(--muted)]">ID</p>
                <p className="font-mono text-[10px] text-[var(--muted)] break-all">{selected.id}</p>
              </div>
            </div>

            <div className="mt-auto space-y-2">
              <button
                onClick={() => navigate('project', projectId, 'runs')}
                className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                View in Runs
              </button>
              <button
                disabled
                title="Dispatch Agent from graph node — coming in G-5"
                className="w-full cursor-not-allowed rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-xs font-semibold text-[var(--muted)] opacity-50"
              >
                Dispatch Agent
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
