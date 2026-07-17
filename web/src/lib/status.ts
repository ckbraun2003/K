/**
 * E-11 — THE single web status mapping module (P0).
 *
 * Replaces the per-component ad-hoc STATUS_COLOR / STATUS_DOT / statusClasses
 * maps on the Runs + Chief surfaces (RunList, RunsTab, RunConsole, ChiefPage,
 * DelegationTree); the full surface sweep is P4. Presentation is keyed off the
 * CANONICAL axes (shared canonicalize*), so a new legacy status can't silently
 * render unstyled: metaForCanonical's switch is compile-time exhaustive over
 * EntityState (no default branch — strict TS reports a missing case as
 * "lacks ending return statement"), and web/test/status.test.ts iterates every
 * enum member at runtime.
 *
 * P0 label decision: labels come from the frozen P0 table below ('error',
 * 'killed', 'interrupted', 'awaiting input') — the canonical AXES drive
 * color/glow/grouping; unified label wording is part of the P4 sweep.
 * Known P0 drift (deliberate): RunList/RunsTab previously rendered the RAW
 * status string, so `awaiting_input` there becomes 'awaiting input' (and
 * RunsTab's formerly-unstyled awaiting_input rows gain the amber treatment).
 * Every other adopted surface keeps its exact prior labels and classes.
 */
import type { AgentRunStatus, CanonicalStatus, DelegationNodeStatus, PipelineStageRun, RunStatus } from '@k/shared'
import {
  canonicalizeAgentRunStatus,
  canonicalizeDelegationNodeStatus,
  canonicalizePipelineStageStatus,
  canonicalizeRunStatus,
} from '@k/shared'

export interface StatusMeta {
  /** Operator-facing label (P0: preserves today's exact strings). */
  label: string
  /** Chip/badge classes (background + text). */
  badge: string
  /** Status-dot classes (solid color; glow when live). */
  dot: string
  /** Plain text color class. */
  text: string
  /** Border+text pair for tree nodes (DelegationTree family). */
  border: string
  /** True for pulsing/live states (running, awaiting input). */
  live: boolean
}

/** Presentation for a canonical triple. Exhaustive over EntityState. */
export function metaForCanonical(c: CanonicalStatus): Omit<StatusMeta, 'label'> {
  switch (c.state) {
    case 'idle':
      return { badge: 'bg-muted/15 text-[var(--muted)]', dot: 'bg-[var(--muted)]', text: 'text-[var(--muted)]', border: 'border-[var(--border)] text-[var(--muted)]', live: false }
    case 'queued':
      return { badge: 'bg-amber/15 text-[var(--amber)]', dot: 'bg-[var(--amber)]', text: 'text-[var(--amber)]', border: 'border-[var(--amber)]/50 text-[var(--amber)]', live: false }
    case 'running':
      return { badge: 'bg-accent/15 text-[var(--accent-hover)]', dot: 'bg-[var(--accent)] glow-live', text: 'text-[var(--accent-hover)]', border: 'border-[var(--accent)]/50 text-[var(--accent-hover)] glow-live', live: true }
    case 'waiting':
      return { badge: 'bg-amber/25 text-[var(--amber)]', dot: 'bg-[var(--amber)] glow-live', text: 'text-[var(--amber)]', border: 'border-[var(--amber)]/50 text-[var(--amber)] glow-live', live: true }
    case 'done':
      return { badge: 'bg-green/15 text-[var(--green)]', dot: 'bg-[var(--green)]', text: 'text-[var(--green)]', border: 'border-[var(--green)]/50 text-[var(--green)]', live: false }
    case 'failed':
      return { badge: 'bg-red/15 text-[var(--red)]', dot: 'bg-[var(--red)]', text: 'text-[var(--red)]', border: 'border-[var(--red)]/50 text-[var(--red)]', live: false }
    case 'stopped':
      // Operator-killed (health ok) reads muted/neutral; a crash-interrupted
      // stop (health degraded) reads red — exactly today's killed/interrupted split.
      return c.health === 'ok'
        ? { badge: 'bg-muted/15 text-[var(--muted)]', dot: 'bg-[var(--muted)]', text: 'text-[var(--muted)]', border: 'border-[var(--border)] text-[var(--muted)]', live: false }
        : { badge: 'bg-red/15 text-[var(--red)]', dot: 'bg-[var(--red)]', text: 'text-[var(--red)]', border: 'border-[var(--red)]/50 text-[var(--red)]', live: false }
  }
}

const RUN_LABELS: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  awaiting_input: 'awaiting input',
  awaiting_plan: 'plan ready',
  done: 'done',
  error: 'error',
  killed: 'killed',
  interrupted: 'interrupted',
}

/** Presentation for a Run's legacy status (Runs surfaces). */
export function runStatusMeta(status: RunStatus): StatusMeta {
  return { label: RUN_LABELS[status], ...metaForCanonical(canonicalizeRunStatus(status)) }
}

/** Presentation for an agent activation status (Chief wake rows). */
export function agentRunStatusMeta(status: AgentRunStatus): StatusMeta {
  return { label: status, ...metaForCanonical(canonicalizeAgentRunStatus(status)) }
}

/** Presentation for a delegation-tree node status (Chief org tree). */
export function delegationStatusMeta(status: DelegationNodeStatus): StatusMeta {
  return { label: status, ...metaForCanonical(canonicalizeDelegationNodeStatus(status)) }
}

/** A pipeline stage's canonical triple — from the wire view, or derived if the
 *  projection omitted it (D-119 C3; usability-access P2.6 Lane A). Shared by
 *  PipelineGraph (re-exported) and PipelineStageNode to avoid a circular import
 *  between the two component modules. */
export function stageCanonical(stage: PipelineStageRun): CanonicalStatus {
  return stage.canonical ?? canonicalizePipelineStageStatus(stage.status)
}

/** A stage is a human gate when its kind is `gate` or it is parked awaiting one.
 *  Lives here (leaf module) so PipelineGraph (re-exported) and PipelineStageNode
 *  share ONE definition — same anti-duplication reason as stageCanonical. */
export function isGate(stage: PipelineStageRun): boolean {
  return stage.kind === 'gate' || stage.status === 'awaiting_gate'
}
