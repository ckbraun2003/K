import { useEffect, useMemo } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background as RFBackground,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { EdgeWhen, PipelineRunView } from '@k/shared'
import { stageCanonical, isGate } from '../lib/status'
import { layoutPipeline, DONE_NODE_ID } from '../lib/pipeline-layout'
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

/** `stageCanonical`/`isGate` live in `lib/status.ts` (a leaf module shared with
 *  PipelineStageNode, no circular import) and are re-exported here — external
 *  callers (`PipelineStageCard.tsx`, tests) import them from this module. */
export { stageCanonical, isGate }

/** Edge stroke color per condition — semantic tokens only (no raw hex). */
export const EDGE_COLOR: Record<EdgeWhen, string> = {
  always: 'var(--border-strong)',
  pass: 'var(--green)',
  fail: 'var(--red)',
  repair: 'var(--amber)',
  loop: 'var(--accent)', // orch-p2: bounded loop back-edge
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
  const { nodes: laidNodes, edges } = useMemo(() => layoutPipeline(view), [view])

  // React Flow node state is the source of truth for POSITIONS (so drag works);
  // `onNodesChange` writes drag/selection deltas into it. Everything else — which
  // nodes exist and their live `data.stage` — is re-synced from the layout on every
  // view change below, so status keeps updating live.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode<PipelineStageNodeData>>([])

  useEffect(() => {
    setRfNodes(prev => {
      // Preserve a position the user has dragged so an in-flight live-status update
      // never snaps a moved node back to its dagre-computed spot.
      const posById = new Map(prev.map(n => [n.id, n.position]))
      return laidNodes.map(n => ({
        id: n.id,
        type: 'stage' as const,
        position: posById.get(n.id) ?? n.position,
        // Thread the selection callback into node data so the node's own inner
        // control can fire it on keyboard (Enter/Space) — React Flow's built-in
        // node keydown only mutates its INTERNAL selection store and never calls
        // onNodeClick, so without this a focused node is mouse-selectable only.
        data: { ...n.data, onSelect: n.id === DONE_NODE_ID ? undefined : onSelectStage },
        selected: n.id === selectedStageKey,
        draggable: true,
        // Node owns a single focus target (its inner role="button"); suppress RF's
        // own wrapper tabIndex so there is exactly one tab stop per node.
        focusable: false,
      }))
    })
  }, [laidNodes, selectedStageKey, onSelectStage, setRfNodes])

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
    if (node.id === DONE_NODE_ID) return
    onSelectStage?.(node.id)
  }

  return (
    <div className="size-full" data-testid="pipeline-graph">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
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
