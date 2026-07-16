import type { CanonicalStatus } from '@k/shared'
import { cn } from '../lib/cn'
import {
  runStatusMeta,
  agentRunStatusMeta,
  delegationStatusMeta,
  metaForCanonical,
  type StatusMeta,
} from '../lib/status'

// Merge every known status literal (Run + AgentRun + DelegationNode) into one
// lookup so StatusPill can accept any canonical status string without
// redefining colors — every entry below is produced by lib/status.ts itself,
// never a locally invented color.
const STATUS_META: Record<string, StatusMeta> = {
  queued: runStatusMeta('queued'),
  running: runStatusMeta('running'),
  awaiting_input: runStatusMeta('awaiting_input'),
  awaiting_plan: runStatusMeta('awaiting_plan'),
  done: runStatusMeta('done'),
  error: runStatusMeta('error'),
  killed: runStatusMeta('killed'),
  interrupted: runStatusMeta('interrupted'),
  completed: agentRunStatusMeta('completed'),
  failed: agentRunStatusMeta('failed'),
  idle: delegationStatusMeta('idle'),
}

const FALLBACK_META = STATUS_META.idle

// `canonical` colors a pill directly off the shared status triple — for surfaces
// (D-119 pipelines) whose statuses aren't in the Run/AgentRun/DelegationNode
// literal set above. Additive + backward-compatible: `status` callers are
// unchanged; a `canonical` caller passes its own `label` (the triple has none).
export function StatusPill({ status, canonical, label, className }: {
  status?: string; canonical?: CanonicalStatus; label?: string; className?: string
}) {
  const meta: StatusMeta = canonical
    ? { label: label ?? '', ...metaForCanonical(canonical) }
    : STATUS_META[status ?? ''] ?? FALLBACK_META
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-micro font-medium',
      'bg-raised border border-border', className)}>
      <span aria-hidden className={cn('size-1.5 rounded-pill', meta.dot)} />
      <span className={cn('uppercase tracking-wide', meta.text)}>{label ?? meta.label}</span>
    </span>
  )
}
