// ─── Off-main-thread knowledge-graph layout (pure, unit-tested) ───────────────
//
// The knowledge graph used to freeze the page on large graphs: react-force-graph-3d
// ran `warmupTicks={300}` — 300 O(n log n) force ticks — SYNCHRONOUSLY on the main
// thread at mount, before first paint (KnowledgeGraphTab D1). This module extracts
// that force computation into a PURE function so it can run OFF the main thread in a
// Web Worker (graph-layout.worker.ts), returning precomputed positions the component
// then pins as fixed `fx/fy/fz` and mounts with `warmupTicks={0} cooldownTicks={0}`
// (zero main-thread simulation). The same function is the synchronous FALLBACK when
// a Worker is unavailable (jsdom/tests/SSR).
//
// PURE + DOM-free on purpose: this module imports ONLY d3-force-3d (already a dep) —
// it deliberately does NOT import from ./graph, because graph.ts runs readToken() at
// module load, which would pull the token table / DOM shims into the worker bundle.
// The three tuning constants below therefore MIRROR graph.ts's live-sim tuning
// (GRAPH_LINK_DISTANCE / GRAPH_CHARGE_STRENGTH / collideRadius) so the precomputed
// layout looks the same as what configureGraphForces produced on the old warmup.
//
// Deterministic: d3-force-3d seeds its RNG with a fixed LCG (lcg.js, s=1) and inits
// node positions via a deterministic phyllotaxis distribution — so a given
// {nodes,links,opts} always yields the same positions. No Math.random anywhere.

// @ts-expect-error d3-force-3d ships no bundled type declarations
import { forceSimulation, forceLink, forceManyBody, forceCollide } from 'd3-force-3d'

export interface LayoutNode {
  id: string
}

export interface LayoutLink {
  source: string | { id?: string }
  target: string | { id?: string }
}

export interface LayoutPosition {
  id: string
  x: number
  y: number
  z: number
}

export interface LayoutOptions {
  /** Max simulation ticks (headless). Exits early once alpha < alphaMin. */
  ticks?: number
  /** Painted node radius — drives the collision radius. */
  nodeSize?: number
  /** Target rest length of a link. */
  linkDistance?: number
  /** Many-body charge (negative = repulsive). */
  chargeStrength?: number
  /** Convergence floor — stop ticking once the sim's alpha drops below this. */
  alphaMin?: number
}

// Mirror graph.ts (GRAPH_WARMUP_TICKS / GRAPH_LINK_DISTANCE / GRAPH_CHARGE_STRENGTH /
// collideRadius). Kept local so this module stays DOM-free (see the header note).
const DEFAULT_TICKS = 300
const DEFAULT_NODE_SIZE = 5
const DEFAULT_LINK_DISTANCE = 60
const DEFAULT_CHARGE_STRENGTH = -240
const DEFAULT_ALPHA_MIN = 0.001
const COLLIDE_PAD = 4

function idOf(endpoint: string | { id?: string }): string | undefined {
  return typeof endpoint === 'object' ? endpoint?.id : endpoint
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Run d3-force-3d to a bounded tick budget and return one `{id,x,y,z}` per input
 * node. PURE: never mutates the caller's `nodes`/`links` (d3 forces mutate their
 * inputs — the sim adds x/y/z/vx…, and forceLink rewrites source/target to node
 * refs — so we work on fresh copies). Deterministic for a given input.
 *
 * Links whose endpoints aren't both present are dropped (forceLink throws on a
 * dangling reference) — mirrors the render-layer link filtering.
 */
export function computeGraphLayout(
  nodes: LayoutNode[],
  links: LayoutLink[],
  opts: LayoutOptions = {},
): LayoutPosition[] {
  const ticks = opts.ticks ?? DEFAULT_TICKS
  const nodeSize = opts.nodeSize ?? DEFAULT_NODE_SIZE
  const linkDistance = opts.linkDistance ?? DEFAULT_LINK_DISTANCE
  const chargeStrength = opts.chargeStrength ?? DEFAULT_CHARGE_STRENGTH
  const alphaMin = opts.alphaMin ?? DEFAULT_ALPHA_MIN

  // Fresh copies so the caller's data (e.g. React Query cache) is never mutated.
  const simNodes = nodes.map(n => ({ id: n.id }))
  const known = new Set(simNodes.map(n => n.id))
  const simLinks = links
    .map(l => ({ source: idOf(l.source), target: idOf(l.target) }))
    .filter(
      (l): l is { source: string; target: string } =>
        l.source != null && l.target != null && known.has(l.source) && known.has(l.target),
    )

  // .stop() cancels the internal d3-timer so the layout never runs asynchronously
  // (d3-timer captures rAF/setTimeout at module load — the frame it schedules on
  // construction is stopped here) — we then tick synchronously for a bounded budget.
  const sim = forceSimulation(simNodes, 3)
    .force('link', forceLink(simLinks).id((n: { id: string }) => n.id).distance(linkDistance))
    .force('charge', forceManyBody().strength(chargeStrength))
    .force('collide', forceCollide(nodeSize + COLLIDE_PAD))
    .stop()

  for (let i = 0; i < ticks; i++) {
    sim.tick()
    if (sim.alpha() < alphaMin) break
  }

  return simNodes.map(n => {
    const p = n as { id: string; x?: number; y?: number; z?: number }
    return { id: p.id, x: finite(p.x), y: finite(p.y), z: finite(p.z) }
  })
}
