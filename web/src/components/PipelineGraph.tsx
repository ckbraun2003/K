import { useMemo } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background as RFBackground,
  Controls,
  MiniMap,
  MarkerType,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { EdgeWhen, PipelineRunView, PipelineStageRun } from '@k/shared'
import { stageCanonical } from '../lib/status'
import { layoutPipeline } from '../lib/pipeline-layout'
import { nodeTypes, type PipelineStageNodeData } from './PipelineStageNode'

/**
 * The live pipeline DAG (D-119 C3), rewritten on `@xyflow/react` + `@dagrejs/dagre`
 * (usability-access P2.6 Lane A). An interactive, read-only viewer: pan/zoom/
 * minimap/controls, drag-to-reposition (ephemeral, not persisted). The pure layout
 * (positions + edge retargeting) lives in `lib/pipeline-layout.ts`; this component
 * only maps that output onto React Flow's node/edge shapes and styles edges per
 * `EdgeWhen`. Live status keeps flowing through the existing
 * `['pipeline-run', runId]` query cache — no new WS plumbing.
 */

const DONE = '__done__'

/** A stage's canonical triple — from the wire view, or derived if the projection omitted
 *  it. Defined in `lib/status.ts` (shared with PipelineStageNode, no circular import)
 *  and re-exported here — `PipelineStageCard.tsx` imports it from this module. */
export { stageCanonical }

/** Edge stroke color per condition — semantic tokens only (no raw hex). */
export const EDGE_COLOR: Record<EdgeWhen, string> = {
  always: 'var(--border-strong)',
  pass: 'var(--green)',
  fail: 'var(--red)',
  repair: 'var(--amber)',
  loop: 'var(--accent)', // orch-p2: bounded loop back-edge
}

export function isGate(stage: PipelineStageRun): boolean {
  return stage.kind === 'gate' || stage.status === 'awaiting_gate'
}

function PipelineGraphInner({
  view,
  selectedStageKey,
  onSelectStage,
}: {
  view: PipelineRunView
  selectedStageKey?: string
  onSelectStage?: (stageKey: string) => void
}) {
  const { nodes, edges } = useMemo(() => layoutPipeline(view), [view])

  const rfNodes: RFNode<PipelineStageNodeData>[] = useMemo(
    () =>
      nodes.map(n => ({
        id: n.id,
        type: 'stage',
        position: n.position,
        data: n.data,
        selected: n.id === selectedStageKey,
        draggable: true,
      })),
    [nodes, selectedStageKey],
  )

  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map(e => {
        const dashed = e.data.when === 'fail' || e.data.when === 'repair'
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated: e.data.when === 'pass',
          markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.data.when] },
          style: { stroke: EDGE_COLOR[e.data.when], strokeDasharray: dashed ? '5 4' : undefined },
          label: e.data.label ?? undefined,
        }
      }),
    [edges],
  )

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.id === DONE) return
    onSelectStage?.(node.id)
  }

  return (
    <div className="size-full" data-testid="pipeline-graph">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable
        panOnScroll
        onNodeClick={handleNodeClick}
      >
        <MiniMap />
        <Controls />
        <RFBackground />
      </ReactFlow>
    </div>
  )
}

export default function PipelineGraph(props: {
  view: PipelineRunView
  selectedStageKey?: string
  onSelectStage?: (stageKey: string) => void
}) {
  return (
    <ReactFlowProvider>
      <PipelineGraphInner {...props} />
    </ReactFlowProvider>
  )
}
