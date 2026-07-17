import dagre from '@dagrejs/dagre'
import type { PipelineRunView, PipelineStageRun, EdgeWhen, HandoffMode } from '@k/shared'

/** The synthetic sink node id (a pipeline edge's `to === 'done'` maps here). A real
 *  stage's `stageKey` can never be `'done'`, so this collision-free sentinel is the
 *  single source of truth shared by the layout, the graph, and the node. */
export const DONE_NODE_ID = '__done__'
const NODE_W = 176
const NODE_H = 64

export interface RFStageNode {
  id: string
  position: { x: number; y: number }
  data: { stage?: PipelineStageRun; isDone: boolean }
}
export interface RFStageEdge {
  id: string
  source: string
  target: string
  data: { when: EdgeWhen; handoff: HandoffMode; label: string | null }
}

export function layoutPipeline(
  view: PipelineRunView,
  opts: { nodeW?: number; nodeH?: number } = {},
): { nodes: RFStageNode[]; edges: RFStageEdge[] } {
  const nodeW = opts.nodeW ?? NODE_W
  const nodeH = opts.nodeH ?? NODE_H
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 72, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))

  const keys = new Set(view.stages.map(s => s.stageKey))
  const needsDone = view.edges.some(e => e.to === 'done')
  for (const s of view.stages) g.setNode(s.stageKey, { width: nodeW, height: nodeH })
  if (needsDone) g.setNode(DONE_NODE_ID, { width: nodeW, height: nodeH })

  // Feed only structural edges to dagre for ranking. Loop/repair back-edges still
  // rank (dagre breaks cycles internally); self-edges are skipped to avoid NaN.
  for (const e of view.edges) {
    if (e.from == null || e.from === e.to) continue
    const target = e.to === 'done' ? DONE_NODE_ID : e.to
    if (!keys.has(e.from)) continue
    if (target !== DONE_NODE_ID && !keys.has(target)) continue
    g.setEdge(e.from, target)
  }
  dagre.layout(g)

  const nodes: RFStageNode[] = []
  for (const s of view.stages) {
    const p = g.node(s.stageKey)
    nodes.push({ id: s.stageKey, position: { x: p.x - nodeW / 2, y: p.y - nodeH / 2 }, data: { stage: s, isDone: false } })
  }
  if (needsDone) {
    const p = g.node(DONE_NODE_ID)
    nodes.push({ id: DONE_NODE_ID, position: { x: p.x - nodeW / 2, y: p.y - nodeH / 2 }, data: { isDone: true } })
  }

  const edges: RFStageEdge[] = []
  for (const e of view.edges) {
    if (e.from == null || e.from === e.to) continue
    const target = e.to === 'done' ? DONE_NODE_ID : e.to
    if (!keys.has(e.from) || (target !== DONE_NODE_ID && !keys.has(target))) continue
    const label = e.when !== 'always' ? e.when : e.handoff !== 'share-tree' ? e.handoff : null
    edges.push({ id: `${e.from}->${e.to}:${e.when}`, source: e.from, target, data: { when: e.when, handoff: e.handoff, label } })
  }
  return { nodes, edges }
}
