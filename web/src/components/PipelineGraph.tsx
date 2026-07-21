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
import { navigate } from '../lib/route'

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

  // The desired RF nodes derived purely from the layout + external state (live
  // `data.stage`, selection, the keyboard-select callback). `onSelect` is threaded
  // into node data so the node's inner control can fire it on keyboard (Enter/Space)
  // — React Flow's own node keydown only mutates its INTERNAL selection store and
  // never calls onNodeClick. `focusable:false` leaves the node's inner role="button"
  // as the single tab stop.
  const built = useMemo<RFNode<PipelineStageNodeData>[]>(
    () =>
      laidNodes.map(n => ({
        id: n.id,
        type: 'stage',
        position: n.position,
        data: {
          ...n.data,
          onSelect: n.id === DONE_NODE_ID ? undefined : onSelectStage,
          runId: n.data.stage?.runId ?? null,
        },
        selected: n.id === selectedStageKey,
        draggable: true,
        focusable: false,
      })),
    [laidNodes, selectedStageKey, onSelectStage],
  )

  // RF node state is the source of truth for POSITIONS (so drag works). INITIALIZE it
  // from the first layout so the nodes render on the FIRST paint (a `useNodesState([])`
  // + effect-populate leaves an empty first render — a race the synchronous tests and
  // CI caught). The effect below re-syncs data/selection on every view change while
  // PRESERVING any user-dragged position, so live status keeps updating.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode<PipelineStageNodeData>>(built)

  useEffect(() => {
    setRfNodes(prev => {
      const posById = new Map(prev.map(n => [n.id, n.position]))
      return built.map(n => ({ ...n, position: posById.get(n.id) ?? n.position }))
    })
  }, [built, setRfNodes])

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

  // A node whose stage carries a linked agent run (B3) navigates straight to
  // that run's console — the DAG becomes a jump-off point, not just a status
  // board. Stages never dispatched to an agent (no `runId` yet) fall back to
  // the existing in-page stage-select highlight.
  const handleNodeClick: NodeMouseHandler<RFNode<PipelineStageNodeData>> = (_event, node) => {
    if (node.id === DONE_NODE_ID) return
    const runId = node.data.runId
    if (runId) {
      navigate('runs', runId)
      return
    }
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
        // K is a dark app — React Flow's built-in dark palette themes the
        // MiniMap/Controls/Background dots to match, instead of the library
        // default white MiniMap that read as a broken box on the glass surface.
        colorMode="dark"
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
