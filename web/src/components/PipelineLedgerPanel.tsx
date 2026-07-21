import { useQuery } from '@tanstack/react-query'
import type { PipelineLedgerEntry, PipelineLedgerKind } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
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

function LedgerRow({
  entry,
  artifactSlug,
  onOpenArtifact,
}: {
  entry: PipelineLedgerEntry
  /** The `artifacts` table slug this row's stage produced, if any (Lane B B4). */
  artifactSlug?: string
  onOpenArtifact?: (slug: string) => void
}) {
  const iteration = iterationOf(entry)
  // Lane B (B4): a ledger 'artifact' entry only carries a git commit SHA
  // (`detail.resultCommit`) — it names no `artifacts` row by itself. The row is
  // clickable only when the caller resolved a REAL artifact for this entry's
  // stage (stageKey → artifacts.linkedRunId join, done by the parent).
  const clickable = entry.kind === 'artifact' && !!artifactSlug && !!onOpenArtifact
  return (
    <div
      data-testid={`pipeline-ledger-entry-${entry.id}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpenArtifact!(artifactSlug!) : undefined}
      onKeyDown={
        clickable
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpenArtifact!(artifactSlug!)
              }
            }
          : undefined
      }
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-border px-3 py-1.5 text-micro',
        clickable && 'cursor-pointer transition-colors hover:border-accent',
      )}
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
      {clickable && <span className="text-accent underline">view artifact</span>}
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
export default function PipelineLedgerPanel({
  runId,
  stageArtifacts,
  onOpenArtifact,
}: {
  runId: string
  /** Lane B (B4): stageKey → artifact slug, derived by the caller (RunDetail) from
   *  the run's artifacts panel query joined on stage.runId === artifact.linkedRunId.
   *  Omitted (or no match for a row's stage) → that row renders as plain text. */
  stageArtifacts?: Record<string, string>
  /** Opens the shared artifact viewer for a clicked 'artifact' row. */
  onOpenArtifact?: (slug: string) => void
}) {
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
            <LedgerRow
              key={entry.id}
              entry={entry}
              artifactSlug={entry.stageKey ? stageArtifacts?.[entry.stageKey] : undefined}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </div>
      )}
    </div>
  )
}
