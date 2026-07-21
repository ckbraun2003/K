import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PipelineStageRun } from '@k/shared'
import { metaForCanonical, stageCanonical, isGate } from '../lib/status'
import { DONE_NODE_ID } from '../lib/pipeline-layout'
import { cn } from '../lib/cn'

// `extends Record<string, unknown>` — @xyflow/react's `Node<T>` generic requires
// its data payload to satisfy that constraint.
export interface PipelineStageNodeData extends Record<string, unknown> {
  stage?: PipelineStageRun
  isDone: boolean
  /** Fires the app's stage selection (Enter/Space keyboard activation). Absent for
   *  the non-interactive `__done__` sink. Mouse selection rides React Flow's
   *  onNodeClick at the graph level. */
  onSelect?: (stageKey: string) => void
  /** The linked AGENT run id (Lane B B3) — threaded from `stage.runId` alongside
   *  `stage` so the graph's click handler can read it without a `stage` cast.
   *  Null/undefined for stages never dispatched to an agent (or the done sink). */
  runId?: string | null
}

function PipelineStageNode({ id, data, selected }: NodeProps & { data: PipelineStageNodeData }) {
  const { stage, isDone, onSelect } = data
  const canonical = stage ? stageCanonical(stage) : { state: 'done' as const, attention: 'none' as const, health: 'ok' as const }
  const meta = metaForCanonical(canonical)
  const gate = stage ? isGate(stage) : false

  const className = cn(
    'surface-solid rounded-control border px-2.5 py-1.5 text-left transition-colors',
    selected ? 'border-accent' : gate ? 'border-amber/45' : 'border-border',
  )

  // Keyboard parity with the graph's mouse onNodeClick: a real stage tile is a
  // focusable button that selects on Enter/Space. RF wrapper focus is suppressed
  // (focusable:false at the graph) so this is the single tab stop per node.
  // Only interactive when a select handler is wired (the live run graph). The
  // read-only definition PREVIEW passes none → non-interactive, so preview nodes
  // aren't focusable buttons that do nothing.
  const interactive = !isDone && typeof onSelect === 'function'
  const onKeyDown = interactive
    ? (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.(id)
        }
      }
    : undefined

  return (
    <div
      className={className}
      data-testid={isDone ? `pipeline-node-${DONE_NODE_ID}` : `pipeline-node-${stage?.stageKey}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive && stage ? `stage ${stage.stageKey}, ${stage.status}` : undefined}
      onKeyDown={onKeyDown}
    >
      <Handle type="target" position={Position.Left} />
      {stage ? (
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
          {/* attempt is non-nullable; a stage not yet attempted (0) — a fresh pending
              stage or a definition-preview node — shows no attempt line, only structure. */}
          {(stage.costUsd != null || stage.attempt > 0) && (
            <div className="mt-0.5 truncate text-micro text-muted">
              {stage.costUsd != null && <span>${stage.costUsd.toFixed(2)}</span>}
              {stage.costUsd != null && stage.attempt > 0 && <span> · </span>}
              {stage.attempt > 0 && (
                <span>
                  attempt {stage.attempt}/{stage.maxAttempts}
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full items-center gap-1.5">
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-pill', meta.dot)} />
          <span className="text-label font-medium text-muted">done</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export default PipelineStageNode
export const nodeTypes = { stage: PipelineStageNode }
