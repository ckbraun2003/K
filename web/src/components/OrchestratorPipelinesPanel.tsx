import type { AgentProfile, PipelineRun } from '@k/shared'
import { canonicalizePipelineRunStatus } from '@k/shared'
import { StatusPill } from '../ui/StatusPill'
import { SectionHeader } from '../ui/SectionHeader'
import { EmptyState } from '../ui/EmptyState'

export interface OwnerPipelineGroup {
  /** null = the "Unassigned" bucket (no dispatch path stamps owner_profile_id yet). */
  profileId: string | null
  label: string
  runs: PipelineRun[]
}

/**
 * Groups pipeline runs by their owning orchestrator (orch-p2 C.3, design §6.2 —
 * "the Chief manages multiple running pipelines"). Only orchestrators that
 * actually own at least one run produce a group — an idle lead contributes
 * nothing. Runs whose `ownerProfileId` is null (no dispatch path stamps the
 * column yet — see pipeline-engine.ts `PipelineRunRow`) bucket under
 * "Unassigned" rather than vanishing, so the panel stays honest about the
 * current state of the ownership wiring. A run owned by a profile id absent
 * from `leads` (stale/unknown) still surfaces, labeled by its raw id, rather
 * than being silently dropped.
 */
export function groupPipelineRunsByOwner(runs: PipelineRun[], leads: AgentProfile[]): OwnerPipelineGroup[] {
  const labelOf = new Map(leads.map(l => [l.id, l.name]))
  const byOwner = new Map<string | null, PipelineRun[]>()
  for (const run of runs) {
    const bucket = byOwner.get(run.ownerProfileId)
    if (bucket) bucket.push(run)
    else byOwner.set(run.ownerProfileId, [run])
  }

  const groups: OwnerPipelineGroup[] = []
  for (const lead of leads) {
    const bucket = byOwner.get(lead.id)
    if (bucket && bucket.length > 0) groups.push({ profileId: lead.id, label: lead.name, runs: bucket })
  }
  for (const [ownerId, bucket] of byOwner) {
    if (ownerId !== null && !labelOf.has(ownerId)) {
      groups.push({ profileId: ownerId, label: ownerId, runs: bucket })
    }
  }
  const unassigned = byOwner.get(null)
  if (unassigned && unassigned.length > 0) groups.push({ profileId: null, label: 'Unassigned', runs: unassigned })

  return groups
}

/**
 * Orchestrator multi-pipeline view (orch-p2 C.3, design §6.2): every pipeline
 * run currently owned by each Chief-child orchestrator, so an operator can see
 * at a glance what each lead has in flight. Pure/presentational — the page
 * that mounts this supplies `runs` (e.g. `api.pipelines.list()`) and `leads`
 * (the orchestrator roster) and reacts to `onSelectRun` to drive its own
 * detail pane.
 */
export default function OrchestratorPipelinesPanel({ runs, leads, onSelectRun }: {
  runs: PipelineRun[]
  leads: AgentProfile[]
  onSelectRun?: (runId: string) => void
}) {
  const groups = groupPipelineRunsByOwner(runs, leads)

  if (groups.length === 0) {
    return (
      <div data-testid="orchestrator-pipelines-empty">
        <EmptyState
          tier="solid"
          icon="runs"
          headline="No orchestrator is running a pipeline"
          hint="Runs appear here, grouped by the orchestrator that owns them."
        />
      </div>
    )
  }

  return (
    <div data-testid="orchestrator-pipelines-panel" className="space-y-4">
      {groups.map(group => (
        <div
          key={group.profileId ?? 'unassigned'}
          data-testid={`orchestrator-pipelines-group-${group.profileId ?? 'unassigned'}`}
        >
          <SectionHeader label={group.label} count={group.runs.length} as="h3" />
          <div className="space-y-1.5">
            {group.runs.map(run => (
              <button
                key={run.id}
                type="button"
                data-testid={`orchestrator-pipelines-run-${run.id}`}
                onClick={() => onSelectRun?.(run.id)}
                className="surface-solid flex w-full items-center gap-2 rounded-control border border-border px-3 py-1.5 text-left text-label hover:border-accent/40"
              >
                <span className="min-w-0 flex-1 truncate">{run.title}</span>
                <StatusPill
                  canonical={canonicalizePipelineRunStatus(run.status)}
                  label={run.status}
                  className="flex-shrink-0"
                />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
