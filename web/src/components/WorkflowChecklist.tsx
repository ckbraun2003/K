import type { WorkflowStep, WorkflowRun } from '@k/shared'
import { cn } from '../lib/cn'
import { linkify } from '../lib/linkify'

/** Glyph + colour per step status — the at-a-glance checklist state. */
const STATUS: Record<WorkflowStep['status'], { icon: string; cls: string }> = {
  pending: { icon: '○', cls: 'text-[var(--muted)]' },
  in_progress: { icon: '◐', cls: 'text-[var(--accent-hover)]' },
  done: { icon: '●', cls: 'text-[var(--green)]' },
  blocked: { icon: '◼', cls: 'text-[var(--amber)]' },
  failed: { icon: '✕', cls: 'text-[var(--red)]' },
}

// Neutral glyph/colour for an out-of-enum status (enum-drift forward-compat):
// one bad row must never blank its valid siblings.
const STATUS_FALLBACK = { icon: '•', cls: 'text-[var(--muted)]' }

/** Short badge label per step kind (ticket · loop phase · review · CI gate). */
const KIND_LABEL: Record<WorkflowStep['kind'], string> = {
  task: 'ticket',
  phase: 'phase',
  review: 'review',
  ci: 'CI',
}

/**
 * The explicit workflow progress checklist — tickets, loop phases, reviews, and
 * the CI gate the orchestrator reports through the kstore status-write tools.
 * Distinct from the inferred run tree: this is what the agent SAYS it's doing.
 */
export default function WorkflowChecklist({
  steps,
  workflowRun,
}: {
  steps: WorkflowStep[]
  workflowRun?: WorkflowRun | null
}) {
  return (
    <div data-testid="wf-checklist" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Workflow checklist
        </h2>
        {workflowRun && (
          <span data-testid="wf-overall-status" className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
            {workflowRun.status}
          </span>
        )}
      </div>

      {steps.length === 0 ? (
        <p data-testid="wf-checklist-empty" className="text-xs italic text-[var(--muted)]">
          No status reported yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {steps.map(s => {
            const st = STATUS[s.status] ?? STATUS_FALLBACK
            return (
              <li
                key={s.id}
                data-testid={`wf-step-${s.id}`}
                className="flex items-start gap-2 text-xs text-[var(--text)]"
              >
                <span className={cn('mt-px font-mono', st.cls)} aria-hidden>
                  {st.icon}
                </span>
                <span className="shrink-0 rounded bg-[var(--raised)] px-1 py-px text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  {KIND_LABEL[s.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn(s.status === 'done' && 'text-[var(--muted)] line-through')}>{s.label}</span>
                  {s.detail && <span className="ml-2 text-[var(--muted)]">— {linkify(s.detail)}</span>}
                </span>
                <span className={cn('shrink-0 text-[10px] uppercase tracking-wide', st.cls)}>
                  {s.status.replace(/_/g, ' ')}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
