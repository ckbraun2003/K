import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PipelineSpec, StageDef } from '@k/shared'
import { api } from '../lib/api'
import { Tag } from '../ui/Tag'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Field'
import { SectionHeader } from '../ui/SectionHeader'
import { ErrorState } from '../ui/ErrorState'
import { SkeletonTile } from '../ui/Skeleton'

/** The actor a given stage runs as — a sub-agent worker if named, else the bare role. */
function actorOf(stage: StageDef): string {
  if (stage.kind !== 'agent') return '—'
  return stage.subagentType ? `${stage.role} → ${stage.subagentType}` : stage.role
}

/** One-line policy summary per stage kind: retry bound, and (for agent stages) model + gate flag. */
function policyOf(stage: StageDef): string[] {
  const bits: string[] = []
  if (stage.retry.maxAttempts > 1) bits.push(`retry ×${stage.retry.maxAttempts}`)
  if (stage.kind === 'agent') {
    if (stage.model) bits.push(stage.model)
    if (stage.planGate) bits.push('plan-gate')
  }
  if (stage.kind === 'gate') bits.push(`gate:${stage.gate.mode}`)
  if (stage.repair) bits.push(`repair→${stage.repair.toStage ?? 'fail'}`)
  return bits
}

/**
 * Read-only render of one stage's definition — kind, actor/subagent, and its
 * policy bits (retry/model/gate). `data-testid` is keyed by stage id so a test
 * (or a future "select stage" affordance) can address it directly.
 */
function StageRow({ stage }: { stage: StageDef }) {
  const policy = policyOf(stage)
  return (
    <div
      data-testid={`pipeline-def-stage-${stage.id}`}
      className="rounded-control border border-border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="mono min-w-0 flex-1 truncate text-label font-semibold text-text">{stage.label}</span>
        <Tag tint="neutral" className="flex-shrink-0 text-micro uppercase tracking-wide">
          {stage.kind}
        </Tag>
      </div>
      <div className="mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted">
        <span>{actorOf(stage)}</span>
        {policy.map(bit => (
          <span key={bit}>{bit}</span>
        ))}
      </div>
    </div>
  )
}

/** Read-only render of one edge — from → to, its handoff mode, and (for a loop
 *  back-edge) the bounded iteration count that keeps it from running forever. */
function EdgeRow({ edge }: { edge: PipelineSpec['edges'][number] }) {
  return (
    <div
      data-testid={`pipeline-def-edge-${edge.from}-${edge.to}`}
      className="mono flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-border px-3 py-1.5 text-micro text-muted"
    >
      <span className="text-text">{edge.from}</span>
      <span aria-hidden>→</span>
      <span className="text-text">{edge.to}</span>
      <Tag tint={edge.when === 'loop' ? 'accent' : 'neutral'} className="text-micro uppercase tracking-wide">
        {edge.when}
      </Tag>
      <span>{edge.handoff}</span>
      {edge.when === 'loop' && <span className="text-accent">max {edge.maxIterations}</span>}
    </div>
  )
}

/**
 * Pipeline definition inspector (orch-p2 C.2) — the operator-facing read view of
 * an executable `PipelineSpec`: overview (name/version/entry/crossProject), the
 * full stage list, and the edge list (with loop bounds called out). A "Clone to
 * edit" toggle reveals the spec as read-only JSON in a Textarea — a copy-out seam
 * for authoring a variant elsewhere, not an in-place editor (Phase-2 scope).
 */
export default function PipelineDefInspector({ defId }: { defId: string }) {
  const [cloneOpen, setCloneOpen] = useState(false)
  const { data: spec, isLoading, isError, refetch } = useQuery<PipelineSpec>({
    queryKey: ['pipeline-def-spec', defId],
    queryFn: () => api.pipelines.get(defId),
  })

  if (isLoading) return <SkeletonTile tier="solid" />
  if (isError || !spec) {
    return (
      <div data-testid="pipeline-def-inspector-error">
        <ErrorState message="Failed to load the pipeline definition." onRetry={() => void refetch()} />
      </div>
    )
  }

  return (
    <div data-testid="pipeline-def-inspector" className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-title">{spec.name}</h3>
          <Button
            variant="ghost"
            size="sm"
            className="border border-border"
            data-testid="pipeline-def-clone-toggle"
            onClick={() => setCloneOpen(o => !o)}
          >
            {cloneOpen ? 'Hide JSON' : 'Clone to edit'}
          </Button>
        </div>
        {spec.description && <p className="mt-1 text-caption text-muted">{spec.description}</p>}
        <div className="mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted">
          <span>version {spec.version}</span>
          <span>entry {spec.entry}</span>
          <span>{spec.crossProject ? 'cross-project' : 'single-project'}</span>
        </div>
      </div>

      {cloneOpen && (
        <Textarea
          data-testid="pipeline-def-clone-textarea"
          aria-label="Pipeline spec JSON"
          readOnly
          value={JSON.stringify(spec, null, 2)}
          className="mono h-48 w-full text-micro"
        />
      )}

      <div>
        <SectionHeader label="Stages" count={spec.stages.length} as="h3" />
        <div className="space-y-1.5">
          {spec.stages.map(stage => (
            <StageRow key={stage.id} stage={stage} />
          ))}
        </div>
      </div>

      <div>
        <SectionHeader label="Edges" count={spec.edges.length} as="h3" />
        <div className="space-y-1.5">
          {spec.edges.map((edge, i) => (
            <EdgeRow key={`${edge.from}-${edge.to}-${i}`} edge={edge} />
          ))}
        </div>
      </div>
    </div>
  )
}
