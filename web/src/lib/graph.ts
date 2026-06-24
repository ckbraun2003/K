import type { GraphNodeEnrichment, WsMessage } from '@k/shared'

// ─── Knowledge-graph render helpers (pure, unit-tested in web/test/graph.test.ts) ──

export type GraphNode = {
  id: string
  label?: string
  type?: string
  group?: string
  enrichment?: GraphNodeEnrichment
  [key: string]: unknown
}

// Canonical node colours, shared by the per-node colour function and the legend so
// they can never drift apart.
export const GRAPH_COLORS = {
  failing: '#f87171', // has critical/error findings
  untested: '#fbbf24', // amber — no last run / explicitly untested
  ok: '#ff8fc0', // blush accent — healthy
  dim: '#4c3a6e', // muted purple — filtered out
} as const

export const GRAPH_LEGEND: { color: string; label: string }[] = [
  { color: GRAPH_COLORS.failing, label: 'Failing' },
  { color: GRAPH_COLORS.untested, label: 'Untested' },
  { color: GRAPH_COLORS.ok, label: 'Healthy' },
]

/** True if a node's enrichment carries any critical-severity verification finding. */
export function hasFailingFindings(node: GraphNode): boolean {
  return (node.enrichment?.findings ?? []).some(f => f.severity === 'critical')
}

/** Whether the node has no derivable signal that it was ever exercised by a run. */
function isUntested(node: GraphNode): boolean {
  if (node.group === 'untested') return true
  // An enriched node with findings but no lastRun is amber; a bare node (no
  // enrichment at all) carries no signal, so it stays the neutral accent colour.
  if (node.enrichment && !node.enrichment.lastRun) return true
  return false
}

/**
 * Per-node colour: failing (red) > untested (amber) > healthy (accent). Nodes that
 * don't match the active filter are dimmed (the filter takes precedence so the user
 * can always see what the filter selected).
 */
export function nodeColor(node: GraphNode, filter: string): string {
  const matches =
    !filter || (node.label ?? node.id ?? '').toString().toLowerCase().includes(filter.toLowerCase())
  if (!matches) return GRAPH_COLORS.dim
  if (node.type === 'error' || node.group === 'failing' || hasFailingFindings(node)) {
    return GRAPH_COLORS.failing
  }
  if (isUntested(node)) return GRAPH_COLORS.untested
  return GRAPH_COLORS.ok
}

// ─── Canvas paint helpers (shared by every ForceGraph2D surface) ──────────────
// The default react-force-graph node is a tiny flat dot and its links are a 1px
// near-invisible hairline on a dark canvas. These helpers draw a glowing node with
// a bright core + a zoom-gated label, and a matching hit-area, so the graph reads
// as a legible diagnostic surface (bible §06). Painting only runs during layout +
// interaction (cooldownTicks settles the sim), so the glow cost isn't continuous.

/** Canvas background for every graph — the new midnight-purple base. */
export const GRAPH_BG = '#1a0f2e'
/** Visible edge colour — sky-blue, semi-transparent, so links read on the dark canvas. */
export const GRAPH_LINK_COLOR = 'rgba(56, 189, 248, 0.4)'

type XYNode = { x?: number; y?: number; label?: string; id?: string | number }

/** Paint a glowing node + (past a zoom threshold) its label. Because this REPLACES
 *  the default node circle, callers must also pass `nodePointerAreaPaint`
 *  (see paintNodePointerArea) so clicks still register. */
export function drawGraphNode(
  node: XYNode,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  color: string,
  size = 5,
): void {
  const x = node.x ?? 0
  const y = node.y ?? 0
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.beginPath()
  ctx.arc(x, y, size, 0, 2 * Math.PI)
  ctx.fillStyle = color
  ctx.fill()
  // bright core for depth
  ctx.shadowBlur = 0
  ctx.beginPath()
  ctx.arc(x, y, size * 0.4, 0, 2 * Math.PI)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.fill()
  ctx.restore()

  const label = String(node.label ?? node.id ?? '')
  if (label && globalScale > 1.3) {
    const fontSize = Math.max(11 / globalScale, 2)
    ctx.font = `${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(244, 240, 255, 0.9)' // --text
    ctx.fillText(label, x, y + size + 1.5)
  }
}

/** Hit-area paint so clicks register against the painted node. `color` is the
 *  unique colour react-force-graph assigns for pointer hit-testing — use it as-is. */
export function paintNodePointerArea(
  node: XYNode,
  ctx: CanvasRenderingContext2D,
  color: string,
  size = 5,
): void {
  const x = node.x ?? 0
  const y = node.y ?? 0
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, size + 2, 0, 2 * Math.PI)
  ctx.fill()
}

export type DispatchAction = 'investigate' | 'fix' | 'explain'

export const DISPATCH_ACTIONS: { action: DispatchAction; label: string; hint: string }[] = [
  { action: 'investigate', label: 'Investigate', hint: 'Survey this code and report findings' },
  { action: 'fix', label: 'Fix', hint: 'Find the root cause and apply a minimal fix' },
  { action: 'explain', label: 'Explain', hint: 'Explain what this code does and how it fits' },
]

/**
 * Mirrors the tab's onWsMessage handler: a graph_update for THIS project invalidates
 * the ['graph', projectId] cache so the graph auto-refreshes when a build finishes or
 * the index goes stale. Extracted so it can be unit-tested without a React renderer.
 */
export function makeGraphUpdateHandler(
  projectId: string,
  qc: { invalidateQueries: (a: { queryKey: unknown[] }) => void },
) {
  return (msg: WsMessage) => {
    if (msg.type === 'graph_update' && msg.projectId === projectId) {
      qc.invalidateQueries({ queryKey: ['graph', projectId] })
    }
  }
}
