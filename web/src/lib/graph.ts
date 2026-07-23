// Import the SAME force engine react-force-graph-2d uses internally (d3-force-3d) so
// we don't run two competing d3 instances. The package ships no type declarations, so
// the import is `any` — suppressed here rather than via a separate global .d.ts file.
// @ts-expect-error d3-force-3d has no bundled type declarations
import { forceCollide } from 'd3-force-3d'
import type { GraphNodeEnrichment, WsMessage } from '@k/shared'
import { readToken } from './tokens'

// ─── Knowledge-graph render helpers (pure, unit-tested in web/test/graph.test.ts) ──

export type GraphNode = {
  id: string
  label?: string
  type?: string
  group?: string
  enrichment?: GraphNodeEnrichment
  [key: string]: unknown
}

// Canonical node colours via readToken; maintains backward compatibility with tests.
// `ok`/`dim` ride the shared palette tokens (violet accent / graphite muted) so a
// future palette retune (like ui-adjustments' purple→violet shift) cascades here
// automatically — `failing`/`untested` stay on the dedicated status tokens.
export const GRAPH_COLORS = {
  failing: readToken('--red'),
  untested: readToken('--amber'),
  ok: readToken('--accent'),
  dim: readToken('--muted'),
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

/** Canvas background for every graph — a neutral graphite (`--graph-bg`), deliberately
 *  decoupled from the app's purple `--bg` so the canvas reads calm behind the glass
 *  node-inspector/legend overlays (ui-adjustments D4) instead of doubling the app chrome. */
export const GRAPH_BG = readToken('--graph-bg')
/** Visible edge colour — low-alpha graphite, so links read as quiet structure rather
 *  than competing with the violet `ok`-status node colour (ui-adjustments D4). */
export const GRAPH_LINK_COLOR = `rgba(${hexToRgb(readToken('--muted'))}, 0.4)`

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return '143, 153, 173' // --muted fallback (graphite)
  const r = parseInt(result[1], 16)
  const g = parseInt(result[2], 16)
  const b = parseInt(result[3], 16)
  return `${r}, ${g}, ${b}`
}

type XYNode = { x?: number; y?: number; label?: string; id?: string | number }

/** Paint a glowing node + (past a zoom threshold) its label. Because this REPLACES
 *  the default node circle, callers must also pass `nodePointerAreaPaint`
 *  (see paintNodePointerArea) so clicks still register.
 *  2D-canvas helper — retained (and unit-tested) for potential reuse; the app graphs
 *  now render in 3D and no longer call this. */
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
 *  unique colour react-force-graph assigns for pointer hit-testing — use it as-is.
 *  2D-canvas helper — retained (and unit-tested) for potential reuse; the app graphs
 *  now render in 3D and no longer call this. */
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

// ─── Force-simulation tuning (shared by every ForceGraph2D surface) ───────────
// d3 force defaults pack nodes tightly: no collision force, a short link distance,
// and a weak charge, so nodes overlap and links pass through them. These constants
// (tuned for a ~30-node graph) space the layout out, and configureGraphForces adds
// the missing collision force.

/** Target rest length of a link, in canvas units. */
export const GRAPH_LINK_DISTANCE = 60
/** Many-body charge: negative = repulsive, so disconnected clusters push apart. */
export const GRAPH_CHARGE_STRENGTH = -240

/**
 * Headless settle depth for the pre-warm-then-freeze render (ui-adjustments D1):
 * `warmupTicks` ticks the d3 simulation this many times BEFORE the first paint
 * (no `d3AlphaMin` is configured, so it always runs the full count rather than
 * exiting early on convergence), then `cooldownTicks={0}` freezes the result —
 * the graph appears fully expanded with no visible spread animation.
 */
export const GRAPH_WARMUP_TICKS = 300

/**
 * Empty graph-data shape for the "phase 1" mount of a warmupTicks-driven
 * ForceGraph3D. `d3Force()` (used by configureGraphForces to register the
 * collide force and tune link/charge) is an IMPERATIVE ref method that only
 * becomes callable AFTER the engine's first mount+digest — and with
 * `warmupTicks` set, that first digest ticks the simulation headlessly and
 * SYNCHRONOUSLY as part of the very same mount, before any caller could reach
 * the ref. Feeding the real graphData straight away would therefore warm the
 * layout against the library's UNTUNED default forces, and `cooldownTicks={0}`
 * means no later tick ever gets a chance to correct it (see the configureGraphForces
 * docblock for why we can't just reheat). Mounting on this empty shape first gives the
 * digest nothing to warm (trivially instant), so the caller's effect can call
 * configureGraphForces() once the ref exists — then swap in the real data;
 * `never[]` is assignable to any node/link array type, so this fits either
 * graph's GraphData shape. The underlying d3ForceLayout instance is created
 * once and persists for the component's lifetime, so later digests (e.g. a
 * knowledge-graph rebuild refresh) automatically reuse the already-tuned
 * forces — this two-phase mount only has to happen once.
 */
export const EMPTY_FORCE_GRAPH_DATA: { nodes: never[]; links: never[] } = { nodes: [], links: [] }

/**
 * Collision radius for a node = its painted size + a small pad, so the painted
 * circles (and their labels' anchor) never touch. PURE — unit-tested.
 */
export function collideRadius(nodeSize: number, labelPad = 4): number {
  return nodeSize + labelPad
}

// ─── Large-graph level-of-detail (guardrail against thousands of nodes) ────────

/** Above this node count the knowledge graph renders a LEVEL-OF-DETAIL subset
 *  (top-N by degree) instead of every node, so a huge graph never overwhelms the
 *  WebGL scene. The off-main-thread layout still only runs on the capped subset. */
export const LOD_NODE_CAP = 1500
/** Above this node count, drop `nodeResolution` (sphere geometry segments) to cut
 *  per-node mesh cost — smaller spheres read fine at scale. */
export const LOD_LOW_RES_THRESHOLD = 500

type LinkEndpoint = string | { id?: string }
function endpointId(e: LinkEndpoint): string | undefined {
  return typeof e === 'object' ? e?.id : e
}

export interface GraphLodResult<N, L> {
  nodes: N[]
  links: L[]
  /** Node count BEFORE capping. */
  total: number
  /** Node count AFTER capping (=== total when not capped). */
  shown: number
  /** True when the graph exceeded the cap and was reduced to a subset. */
  capped: boolean
}

/**
 * Level-of-detail cap for large graphs. Returns the graph unchanged when
 * `nodes.length <= cap`; otherwise keeps the top-`cap` nodes by DEGREE (the
 * most-connected structural hubs) and only the links whose BOTH endpoints survive.
 * PURE + deterministic (stable tie-break on original index) — and never a SILENT
 * truncation: `capped`/`total`/`shown` let the UI annotate "N of M shown".
 */
export function applyGraphLod<
  N extends { id: string },
  L extends { source: LinkEndpoint; target: LinkEndpoint },
>(nodes: N[], links: L[], cap: number = LOD_NODE_CAP): GraphLodResult<N, L> {
  const total = nodes.length
  if (total <= cap) return { nodes, links, total, shown: total, capped: false }

  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.id, 0)
  for (const l of links) {
    const s = endpointId(l.source)
    const t = endpointId(l.target)
    if (s != null && degree.has(s)) degree.set(s, (degree.get(s) ?? 0) + 1)
    if (t != null && degree.has(t)) degree.set(t, (degree.get(t) ?? 0) + 1)
  }

  // Rank by degree desc, tie-break by original index so the selection is stable.
  const keptIds = new Set(
    nodes
      .map((n, i) => ({ id: n.id, i, d: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.d - a.d || a.i - b.i)
      .slice(0, cap)
      .map(r => r.id),
  )
  // Preserve original node order among the survivors (deterministic; keeps identity
  // stable across a text-filter toggle over the same capped set).
  const keptNodes = nodes.filter(n => keptIds.has(n.id))
  const keptLinks = links.filter(l => {
    const s = endpointId(l.source)
    const t = endpointId(l.target)
    return s != null && t != null && keptIds.has(s) && keptIds.has(t)
  })
  return { nodes: keptNodes, links: keptLinks, total, shown: keptNodes.length, capped: true }
}

// Minimal structural type for the bits of a ForceGraph2D ref we touch. Typed loosely
// (the library's own types expose these as `any`); a fake satisfying this is used in tests.
interface ForceGraphInstance {
  d3Force(name: string): { distance?: (d: number) => unknown; strength?: (s: number) => unknown } | undefined
  d3Force(name: string, force: unknown): unknown
}

/**
 * Apply layout forces to a ForceGraph instance so nodes don't overlap and edges
 * rarely cross through nodes. NOTE: this prevents NODE overlap (a collision force) and
 * spaces nodes out (link distance + charge); it does NOT eliminate EDGE–EDGE crossings,
 * which is a graph-planarity problem that's generally impossible for non-planar graphs.
 *
 * Safe to call with a null/undefined ref (refs start null) — it's a no-op then. The
 * link/charge forces are created by the library once the graph has data, so we guard
 * their tuning with optional-chaining.
 *
 * We deliberately do NOT call `d3ReheatSimulation()` here. In the 3D `three-forcegraph`
 * engine, `state.layout` is `undefined` until the first graphData digest runs; reheating
 * before that digest flips `engineRunning = true` while `state.layout` is still undefined,
 * so the next animation frame calls `state.layout.tick()` and crashes
 * (`Cannot read properties of undefined (reading 'tick')`) — the WebGL canvas then stays
 * black. The graphData digest already reheats the sim with `alpha(1)`, and our
 * collide/charge/link forces are registered on `state.d3ForceLayout` before that digest,
 * so they still take effect without any explicit reheat. (The 2D `force-graph` engine
 * inits its layout eagerly so the same code never crashed there — only after the 3D
 * migration.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function configureGraphForces(fg: any, opts?: { nodeSize?: number }): void {
  if (!fg) return
  const instance = fg as ForceGraphInstance
  instance.d3Force('collide', forceCollide(collideRadius(opts?.nodeSize ?? 5)))
  instance.d3Force('link')?.distance?.(GRAPH_LINK_DISTANCE)
  instance.d3Force('charge')?.strength?.(GRAPH_CHARGE_STRENGTH)
}

/** DF-2 — with 1–2 nodes zoomToFit computes a degenerate bounding sphere and
 *  parks the camera INSIDE the node mesh (a viewport-filling untextured
 *  sphere; Fit can't recover). For tiny fleets we pin the camera to a fixed
 *  sane distance instead of fitting. */
export const SMALL_FLEET_CAMERA_Z = 300

export function smallFleetCameraZ(nodeCount: number): number | null {
  return nodeCount > 0 && nodeCount < 3 ? SMALL_FLEET_CAMERA_Z : null
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
