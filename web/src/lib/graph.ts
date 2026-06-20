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
  failing: '#ef4444', // has critical/error findings
  untested: '#eab308', // amber — no last run / explicitly untested
  ok: '#6366f1', // accent
  dim: '#3a3a44', // filtered out
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
