import { useMemo } from 'react'
import {
  canonicalizePipelineStageStatus,
  type CanonicalStatus,
  type EdgeWhen,
  type HandoffMode,
  type PipelineRunView,
  type PipelineStageRun,
} from '@k/shared'
import { metaForCanonical } from '../lib/status'
import { cn } from '../lib/cn'

/**
 * The live pipeline DAG (D-119 C3). A HAND-LAID topological SVG/CSS layout — the
 * same posture as WorkflowDiagram (no force-graph: react-force-graph blanked the
 * canvas via AFRAME, see project memory). Columns are computed from the edge set
 * (longest-path depth); each stage is an accessible tile colored off the shared
 * status triple (`metaForCanonical(stage.canonical)`), and edges are SVG bezier
 * connectors styled distinctly per `when` (pass/fail/repair) + `handoff`
 * (branch/merge). Scrolls horizontally inside its own container so a wide pipeline
 * never forces a page-level horizontal scroll.
 */

const NODE_W = 160
const NODE_H = 58
const COL_GAP = 72
const ROW_GAP = 16
const PAD = 10
/** The reserved `done` sink — a stage id may never be 'done' (PipelineSpec superRefine). */
const DONE = '__done__'

/** A stage's canonical triple — from the wire view, or derived if the projection omitted it. */
export function stageCanonical(stage: PipelineStageRun): CanonicalStatus {
  return stage.canonical ?? canonicalizePipelineStageStatus(stage.status)
}

interface Node {
  key: string
  stage?: PipelineStageRun
  col: number
  row: number
  x: number
  y: number
}
interface LayoutEdge {
  from: string
  to: string
  when: EdgeWhen
  handoff: HandoffMode
  path: string
  label: string | null
  midX: number
  midY: number
}
export interface PipelineLayout {
  nodes: Node[]
  edges: LayoutEdge[]
  width: number
  height: number
}

/** Longest-path column index per stage, ignoring `repair` back-edges (they loop
 *  backward and would otherwise inflate depth / never settle). Pure + exported. */
export function pipelineDepths(view: PipelineRunView): Map<string, number> {
  const keys = view.stages.map(s => s.stageKey)
  const keySet = new Set(keys)
  const forward = view.edges.filter(
    e => e.from != null && e.from !== e.to && e.when !== 'repair' && (e.to === 'done' || keySet.has(e.to)),
  )
  const depth = new Map<string, number>(keys.map(k => [k, 0]))
  // Bellman-style relaxation, capped at node count — a repair-free forward graph is
  // a DAG, so this settles; the cap guards against a malformed cyclic spec.
  for (let i = 0; i < keys.length; i++) {
    let changed = false
    for (const e of forward) {
      if (e.to === 'done' || e.from == null) continue
      const d = (depth.get(e.from) ?? 0) + 1
      if (d > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, d)
        changed = true
      }
    }
    if (!changed) break
  }
  return depth
}

function edgePath(src: Node, tgt: Node): { path: string; midX: number; midY: number } {
  const sx = src.x + NODE_W
  const sy = src.y + NODE_H / 2
  const tx = tgt.x
  const ty = tgt.y + NODE_H / 2
  if (src.key === tgt.key) {
    // Repair self-loop — a small lobe off the node's right edge.
    const rx = src.x + NODE_W
    const ry = src.y + NODE_H / 2
    return {
      path: `M ${rx} ${ry - 12} C ${rx + 46} ${ry - 40}, ${rx + 46} ${ry + 40}, ${rx} ${ry + 12}`,
      midX: rx + 40,
      midY: ry,
    }
  }
  if (tgt.col <= src.col) {
    // Back-edge (repair / same-column) — dip below the row band.
    const dipY = Math.max(sy, ty) + NODE_H
    return {
      path: `M ${sx} ${sy} C ${sx + 30} ${dipY}, ${tx - 30} ${dipY}, ${tx} ${ty}`,
      midX: (sx + tx) / 2,
      midY: dipY - 6,
    }
  }
  const dx = Math.max(24, (tx - sx) * 0.5)
  return {
    path: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
    midX: (sx + tx) / 2,
    midY: (sy + ty) / 2 - 6,
  }
}

/** Full topological layout (positions + edge paths). Pure + exported for testing. */
export function layoutPipeline(view: PipelineRunView): PipelineLayout {
  const depth = pipelineDepths(view)
  const needsDone = view.edges.some(e => e.to === 'done')
  const cols = new Map<number, Node[]>()
  const byKey = new Map<string, Node>()

  const place = (key: string, stage: PipelineStageRun | undefined, col: number) => {
    const list = cols.get(col) ?? []
    const node: Node = { key, stage, col, row: list.length, x: 0, y: 0 }
    list.push(node)
    cols.set(col, list)
    byKey.set(key, node)
  }

  for (const stage of view.stages) place(stage.stageKey, stage, depth.get(stage.stageKey) ?? 0)
  if (needsDone) {
    // The sink sits one column right of the furthest stage feeding it.
    const feeders = view.edges.filter(e => e.to === 'done' && e.from != null).map(e => depth.get(e.from as string) ?? 0)
    place(DONE, undefined, (feeders.length ? Math.max(...feeders) : 0) + 1)
  }

  const maxCol = Math.max(0, ...[...cols.keys()])
  const maxRows = Math.max(1, ...[...cols.values()].map(l => l.length))
  for (const [col, list] of cols) {
    list.forEach(node => {
      node.x = PAD + col * (NODE_W + COL_GAP)
      node.y = PAD + node.row * (NODE_H + ROW_GAP)
    })
  }

  const hasBack = view.edges.some(e => {
    if (e.from == null) return false
    const s = byKey.get(e.from)
    const t = e.to === 'done' ? byKey.get(DONE) : byKey.get(e.to)
    return s && t && (t.col <= s.col || s.key === t.key)
  })

  const edges: LayoutEdge[] = []
  for (const e of view.edges) {
    if (e.from == null) continue
    const src = byKey.get(e.from)
    const tgt = e.to === 'done' ? byKey.get(DONE) : byKey.get(e.to)
    if (!src || !tgt) continue
    const { path, midX, midY } = edgePath(src, tgt)
    const label =
      e.when !== 'always' ? e.when : e.handoff !== 'share-tree' ? e.handoff : null
    edges.push({ from: e.from, to: e.to, when: e.when, handoff: e.handoff, path, label, midX, midY })
  }

  const width = PAD * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP + (hasBack ? NODE_H : 0)
  return { nodes: [...byKey.values()], edges, width, height }
}

/** SVG stroke color per edge condition — semantic tokens only (no raw hex). */
const EDGE_COLOR: Record<EdgeWhen, string> = {
  always: 'var(--border-strong)',
  pass: 'var(--green)',
  fail: 'var(--red)',
  repair: 'var(--amber)',
}

function isGate(stage: PipelineStageRun): boolean {
  return stage.kind === 'gate' || stage.status === 'awaiting_gate'
}

function NodeTile({
  node,
  selected,
  onSelect,
}: {
  node: Node
  selected: boolean
  onSelect?: (stageKey: string) => void
}) {
  const stage = node.stage
  const canonical = stage ? stageCanonical(stage) : { state: 'done' as const, attention: 'none' as const, health: 'ok' as const }
  const meta = metaForCanonical(canonical)
  const gate = stage ? isGate(stage) : false
  const style = { left: node.x, top: node.y, width: NODE_W, height: NODE_H } as const

  const body = stage ? (
    <>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-pill', meta.dot)} />
        <span className="mono min-w-0 flex-1 truncate text-micro text-muted">{stage.stageKey}</span>
        {gate && (
          <span className="rounded-pill bg-amber/20 px-1 text-micro font-semibold uppercase tracking-wide text-amber">
            gate
          </span>
        )}
      </div>
      <div className={cn('mt-1 truncate text-label font-medium', meta.text)}>{stage.status}</div>
    </>
  ) : (
    <div className="flex h-full items-center gap-1.5">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-pill', meta.dot)} />
      <span className="text-label font-medium text-muted">done</span>
    </div>
  )

  const className = cn(
    'surface-solid absolute overflow-hidden rounded-control border px-2.5 py-1.5 text-left transition-colors',
    selected ? 'border-accent' : gate ? 'border-amber/45' : 'border-border',
    onSelect && 'hover:border-border-strong focus-visible:glow-focus',
  )

  if (!onSelect || !stage) {
    return (
      <div className={className} style={style} data-testid={`pipeline-node-${node.key}`}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      aria-pressed={selected}
      data-testid={`pipeline-node-${node.key}`}
      onClick={() => onSelect(stage.stageKey)}
    >
      {body}
    </button>
  )
}

export default function PipelineGraph({
  view,
  selectedStageKey,
  onSelectStage,
}: {
  view: PipelineRunView
  selectedStageKey?: string
  onSelectStage?: (stageKey: string) => void
}) {
  const layout = useMemo(() => layoutPipeline(view), [view])

  return (
    <div className="overflow-x-auto" data-testid="pipeline-graph">
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: layout.width }}>
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          <defs>
            {(['always', 'pass', 'fail', 'repair'] as EdgeWhen[]).map(w => (
              <marker
                key={w}
                id={`pl-arrow-${w}`}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 Z" fill={EDGE_COLOR[w]} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e, i) => {
            const dashed = e.when === 'fail' || e.when === 'repair'
            return (
              <g key={i}>
                <path
                  d={e.path}
                  fill="none"
                  stroke={EDGE_COLOR[e.when]}
                  strokeWidth={1.5}
                  strokeDasharray={dashed ? '5 4' : undefined}
                  markerEnd={`url(#pl-arrow-${e.when})`}
                  opacity={0.85}
                />
                {e.label && (
                  <text
                    x={e.midX}
                    y={e.midY}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--muted)"
                    className="mono"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {layout.nodes.map(node => (
          <NodeTile
            key={node.key}
            node={node}
            selected={!!node.stage && node.stage.stageKey === selectedStageKey}
            onSelect={onSelectStage}
          />
        ))}
      </div>
    </div>
  )
}
