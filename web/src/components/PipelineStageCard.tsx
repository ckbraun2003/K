import { useMutation } from '@tanstack/react-query'
import type { PipelineRunView, PipelineStageRun } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { StatusPill } from '../ui/StatusPill'
import { Button } from '../ui/Button'
import { Tag } from '../ui/Tag'
import { stageCanonical } from './PipelineGraph'

/** Small measured-cost formatter: 4 decimals under $1 (stage costs are tiny), 2 above. */
function fmtCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

/**
 * Per-stage detail card (D-119 C3). Canonical StatusPill + attempt/repair counts +
 * measured per-stage cost, a current-gate badge, and the state-gated action buttons:
 * a parked gate opens the PipelineGateDialog (Review), and a settled stage
 * (passed/failed) can be rewound/retried via `api.pipelines.rewindStage`. Buttons
 * appear ONLY where the stage state permits the action.
 */
export default function PipelineStageCard({
  stage,
  runId,
  selected,
  onSelect,
  onReviewGate,
  onView,
}: {
  stage: PipelineStageRun
  runId: string
  selected?: boolean
  onSelect?: (stageKey: string) => void
  /** Open the gate-resolution dialog for this (parked) stage. */
  onReviewGate?: (stage: PipelineStageRun) => void
  /** The refreshed run view a rewind returns — the parent updates its cache with it. */
  onView?: (view: PipelineRunView) => void
}) {
  const canonical = stageCanonical(stage)
  const parkedGate = stage.status === 'awaiting_gate'
  // A settled stage can be rewound (re-run from its base). Failed → "Retry",
  // passed → "Rewind"; both hit the same rewind seam.
  const rewindable = stage.status === 'failed' || stage.status === 'passed'

  const rewind = useMutation({
    mutationFn: () => api.pipelines.rewindStage(runId, stage.id),
    onSuccess: view => onView?.(view),
  })

  return (
    <div
      data-testid={`pipeline-stage-${stage.stageKey}`}
      className={cn(
        'surface-solid rounded-control border p-3 transition-colors',
        selected ? 'border-accent' : parkedGate ? 'border-amber/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(stage.stageKey)}
            className="mono min-w-0 flex-1 truncate text-left text-label font-semibold text-text hover:text-accent-hover"
          >
            {stage.stageKey}
          </button>
        ) : (
          <span className="mono min-w-0 flex-1 truncate text-label font-semibold text-text">{stage.stageKey}</span>
        )}
        <Tag tint="neutral" className="flex-shrink-0 text-micro uppercase tracking-wide">
          {stage.kind}
        </Tag>
        <StatusPill canonical={canonical} label={stage.status} className="flex-shrink-0" />
      </div>

      {/* Measured facts — attempts, repairs, cost. */}
      <div className="mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted">
        <span>
          attempt {stage.attempt}/{stage.maxAttempts}
        </span>
        {stage.repairs > 0 && (
          <span className="text-amber">
            {stage.repairs} repair{stage.repairs === 1 ? '' : 's'}
          </span>
        )}
        {stage.costUsd != null && <span>{fmtCost(stage.costUsd)}</span>}
        {stage.failureClass && <span className="text-red">{stage.failureClass}</span>}
      </div>

      {parkedGate && (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-amber">
          <span aria-hidden className="size-1.5 rounded-pill bg-amber glow-live" />
          Gate parked — awaiting your review.
        </p>
      )}
      {stage.gateNote && <p className="mt-1 text-caption text-muted">{stage.gateNote}</p>}

      {(parkedGate || rewindable) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {rewindable && (
            <Button
              variant="ghost"
              size="sm"
              className="border border-border"
              data-testid={`pipeline-stage-rewind-${stage.stageKey}`}
              loading={rewind.isPending}
              onClick={() => rewind.mutate()}
            >
              {stage.status === 'failed' ? 'Retry' : 'Rewind'}
            </Button>
          )}
          {parkedGate && (
            <Button
              variant="primary"
              size="sm"
              icon="check"
              data-testid={`pipeline-stage-gate-${stage.stageKey}`}
              onClick={() => onReviewGate?.(stage)}
            >
              Review gate
            </Button>
          )}
        </div>
      )}

      {rewind.isError && (
        <p className="mt-2 text-caption text-red" data-testid={`pipeline-stage-error-${stage.stageKey}`}>
          {(rewind.error as Error).message}
        </p>
      )}
    </div>
  )
}
