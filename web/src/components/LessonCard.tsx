import type { MemoryLesson } from '../lib/memory'
import { relativeTime } from '../lib/verify'

/**
 * One proposed/reviewed lesson card. Moved out of MemoryPage.tsx (UI Simplification
 * Task 17) so OrchestratorDetailPage's per-lead Memory tab can reuse it verbatim
 * instead of re-deriving the same card. Actions render only when the callbacks are
 * supplied (a pending list wires them; an accepted/rejected history view omits them
 * -> a read-only card). Approve is compose-is-confirm (direct, D-026); Reject asks the
 * parent to open a confirm step via onReject.
 */
export function LessonCard({
  lesson,
  onApprove,
  onReject,
  busy,
}: {
  lesson: MemoryLesson
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  busy?: boolean
}) {
  const actionable = onApprove != null || onReject != null
  return (
    <div
      data-testid={`memory-lesson-${lesson.id}`}
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
    >
      <p className="text-sm text-[var(--text)]">{lesson.lesson}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--muted)]">
        <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">
          {lesson.profileName ?? 'unassigned'}
        </span>
        <span className="mono">{lesson.runId ? lesson.runId.slice(0, 8) : 'no run'}</span>
        <span>proposed {relativeTime(lesson.createdAt)}</span>
        {lesson.reviewedAt != null && <span>· reviewed {relativeTime(lesson.reviewedAt)}</span>}
      </div>

      {actionable && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => onApprove?.(lesson.id)}
            disabled={busy}
            data-testid={`memory-approve-${lesson.id}`}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '…' : '✓ Approve'}
          </button>
          <button
            onClick={() => onReject?.(lesson.id)}
            data-testid={`memory-reject-${lesson.id}`}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--red)] transition-colors hover:bg-red/15"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
