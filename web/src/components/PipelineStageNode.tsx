import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PipelineStageRun } from '@k/shared'
import { metaForCanonical, stageCanonical } from '../lib/status'
import { cn } from '../lib/cn'

function isGate(stage: PipelineStageRun): boolean {
  return stage.kind === 'gate' || stage.status === 'awaiting_gate'
}

// `extends Record<string, unknown>` — @xyflow/react's `Node<T>` generic requires
// its data payload to satisfy that constraint.
export interface PipelineStageNodeData extends Record<string, unknown> {
  stage?: PipelineStageRun
  isDone: boolean
}

function PipelineStageNode({ data, selected }: NodeProps & { data: PipelineStageNodeData }) {
  const { stage, isDone } = data
  const canonical = stage ? stageCanonical(stage) : { state: 'done' as const, attention: 'none' as const, health: 'ok' as const }
  const meta = metaForCanonical(canonical)
  const gate = stage ? isGate(stage) : false

  const className = cn(
    'surface-solid rounded-control border px-2.5 py-1.5 text-left transition-colors',
    selected ? 'border-accent' : gate ? 'border-amber/45' : 'border-border',
  )

  return (
    <div className={className} data-testid={isDone ? `pipeline-node-${'__done__'}` : `pipeline-node-${stage?.stageKey}`}>
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
          {(stage.costUsd != null || stage.attempt != null) && (
            <div className="mt-0.5 truncate text-micro text-muted">
              {stage.costUsd != null && <span>${stage.costUsd.toFixed(2)}</span>}
              {stage.costUsd != null && stage.maxAttempts != null && <span> · </span>}
              {stage.attempt != null && stage.maxAttempts != null && (
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
