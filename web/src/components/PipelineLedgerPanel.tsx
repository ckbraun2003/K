import { useQuery } from '@tanstack/react-query'
import type { PipelineLedgerEntry, PipelineLedgerKind } from '@k/shared'
import { api } from '../lib/api'
import { Tag } from '../ui/Tag'
import { SectionHeader } from '../ui/SectionHeader'
import { ErrorState } from '../ui/ErrorState'
import { EmptyState } from '../ui/EmptyState'
import { SkeletonTile } from '../ui/Skeleton'

const KIND_TINT: Record<PipelineLedgerKind, 'neutral' | 'accent' | 'sky'> = {
  transition: 'neutral',
  note: 'neutral',
  cost: 'sky',
  artifact: 'sky',
  iteration: 'accent',
  gate: 'accent',
}

/** Small measured-cost formatter — mirrors PipelineStageCard's fmtCost. */
function fmtCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

function entryTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** Best-effort loop iteration number out of an `iteration`-kind entry's opaque
 *  `detail` payload (the engine's own shape — this reads defensively). */
function iterationOf(entry: PipelineLedgerEntry): number | undefined {
  if (entry.kind !== 'iteration') return undefined
  const d = entry.detail as { iteration?: unknown } | undefined
  return typeof d?.iteration === 'number' ? d.iteration : undefined
}

function LedgerRow({ entry }: { entry: PipelineLedgerEntry }) {
  const iteration = iterationOf(entry)
  return (
    <div
      data-testid={`pipeline-ledger-entry-${entry.id}`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-border px-3 py-1.5 text-micro"
    >
      <span className="mono text-muted">{entryTime(entry.ts)}</span>
      <Tag tint={KIND_TINT[entry.kind]} className="flex-shrink-0 text-micro uppercase tracking-wide">
        {entry.kind}
      </Tag>
      {entry.stageKey && <span className="mono text-text">{entry.stageKey}</span>}
      {entry.actor && <span className="text-muted">{entry.actor}</span>}
      {iteration != null && <span className="text-accent">iteration {iteration}</span>}
      {entry.cost != null && <span className="mono text-muted">{fmtCost(entry.cost)}</span>}
      {entry.goal && <span className="min-w-0 flex-1 truncate text-muted">{entry.goal}</span>}
    </div>
  )
}

/**
 * Pipeline run progress ledger (orch-p2 C.3, design §6.1) — the append-only
 * per-run narrative: every stage transition, retry, loop iteration, gate
 * decision, and cost event, in `seq` order. Live: the app-wide
 * `makePipelineInvalidator` refetches this query whenever a `pipeline_update`
 * delta carries a fresher `ledgerSeq` cursor (live-invalidate.ts).
 */
export default function PipelineLedgerPanel({ runId }: { runId: string }) {
  const { data: entries, isLoading, isError, refetch } = useQuery<PipelineLedgerEntry[]>({
    queryKey: ['pipeline-ledger', runId],
    queryFn: () => api.pipelines.ledger(runId),
  })

  if (isLoading) return <SkeletonTile tier="solid" />
  if (isError || !entries) {
    return (
      <div data-testid="pipeline-ledger-error">
        <ErrorState message="Failed to load the pipeline ledger." onRetry={() => void refetch()} />
      </div>
    )
  }

  return (
    <div data-testid="pipeline-ledger-panel">
      <SectionHeader label="Ledger" count={entries.length} as="h3" />
      {entries.length === 0 ? (
        <div data-testid="pipeline-ledger-empty">
          <EmptyState tier="solid" icon="file" headline="No ledger entries yet" hint="Entries appear as the run progresses." />
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map(entry => (
            <LedgerRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
