import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { LessonStatus } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { relativeTime } from '../lib/verify'
import type { MemoryLesson } from '../lib/memory'
import ConfirmDialog from '../components/ConfirmDialog'
import Toast from '../components/Toast'

const STATUS_TABS: { id: LessonStatus; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
]

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<LessonStatus>('pending')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // ONE batched query per status — no per-item fan-out. Refetches when the tab changes.
  const { data: lessons = [], isLoading } = useQuery<MemoryLesson[]>({
    queryKey: ['memory', 'lessons', status],
    queryFn: () => api.memory.lessons({ status }),
  })

  // Thread the lesson id as the mutation VARIABLE (mutate(id)); invalidate every status list so the
  // approved/rejected item leaves the pending tab and appears under its new status.
  const approveMutation = useMutation({
    mutationFn: (id: string) => api.memory.approve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory', 'lessons'] })
      setToast('Lesson accepted')
    },
    // Surface a failed approve (e.g. a concurrent-operator 409 race) instead of silently
    // re-enabling the button — symmetry with reject's ConfirmDialog error.
    onError: (e: unknown) => setToast(`Approve failed: ${(e as Error).message}`),
  })
  const rejectMutation = useMutation({
    mutationFn: (id: string) => api.memory.reject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory', 'lessons'] })
      setRejectId(null)
      setToast('Lesson rejected')
    },
  })

  const actionable = status === 'pending'
  const rejectTarget = rejectId != null ? lessons.find(l => l.id === rejectId) ?? null : null

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Memory review · {lessons.length} {status}
        </h2>
      </div>

      <p className="mt-2 text-xs text-[var(--muted)]">
        Agents <span className="font-medium text-[var(--text)]">propose</span> durable lessons; they
        stay pending until you approve them. Memory is a gated tool, not a file (layer A).
      </p>

      {/* Status tabs */}
      <div className="mt-4 flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-1 text-xs">
        {STATUS_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setStatus(t.id)}
            data-testid={`memory-tab-${t.id}`}
            aria-pressed={status === t.id}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 font-semibold transition-colors',
              status === t.id
                ? 'bg-[var(--accent)] text-[var(--bg)]'
                : 'text-[var(--muted)] hover:text-[var(--text)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Lessons */}
      <section className="mt-4 flex flex-col gap-2">
        {isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
        {!isLoading && lessons.length === 0 && (
          <p data-testid="memory-empty" className="text-sm text-[var(--muted)]">
            {status === 'pending'
              ? 'No lessons awaiting review. Agents will propose new ones here.'
              : `No ${status} lessons.`}
          </p>
        )}
        {lessons.map(lesson => (
          <LessonCard
            key={lesson.id}
            lesson={lesson}
            onApprove={actionable ? id => approveMutation.mutate(id) : undefined}
            onReject={actionable ? id => setRejectId(id) : undefined}
            busy={approveMutation.isPending && approveMutation.variables === lesson.id}
          />
        ))}
      </section>

      <ConfirmDialog
        open={rejectTarget != null}
        title="Reject lesson"
        message={
          rejectTarget ? (
            <>
              This proposed lesson will be marked rejected and never added to memory.
              <span className="mt-2 block rounded-lg bg-[var(--raised)] px-3 py-2 text-[var(--text)]">
                {rejectTarget.lesson}
              </span>
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Reject"
        testid="memory-reject-dialog"
        busy={rejectMutation.isPending}
        error={rejectMutation.isError ? (rejectMutation.error as Error).message : undefined}
        onConfirm={() => { if (rejectId) rejectMutation.mutate(rejectId) }}
        onCancel={() => { setRejectId(null); rejectMutation.reset() }}
      />

      <Toast
        open={toast !== null}
        testid="memory-toast"
        message={toast ?? ''}
        onDismiss={() => setToast(null)}
      />
    </div>
  )
}

// ─── Lesson card (prop-fed, render-testable) ──────────────────────────────────

/**
 * One proposed lesson. Actions render only when the callbacks are supplied (the pending tab wires
 * them; the accepted/rejected history view omits them → a read-only card). Approve is compose-is-
 * confirm (direct, D-026); Reject asks the parent to open a ConfirmDialog via onReject.
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
