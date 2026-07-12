import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { LessonStatus, AgentProfile } from '@k/shared'
import { api } from '../lib/api'
import type { MemoryLesson } from '../lib/memory'
import ConfirmDialog from '../components/ConfirmDialog'
import SegControl from '../components/SegControl'
import Toast from '../components/Toast'
import { LessonCard } from '../components/LessonCard'

const STATUS_TABS: { id: LessonStatus; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
]

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<LessonStatus>('pending')
  // '' = All profiles; otherwise the server-side ?profileId filter.
  const [profileId, setProfileId] = useState('')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // The UNFILTERED per-status list — always fetched: it feeds the profile-filter
  // OPTIONS (distinct proposing profiles) even while a filter is active, so picking
  // one profile doesn't collapse the options to just itself.
  const { data: allLessons = [] } = useQuery<MemoryLesson[]>({
    queryKey: ['memory', 'lessons', status],
    queryFn: () => api.memory.lessons({ status }),
  })

  // The DISPLAYED list. When no filter is active the key collapses to the
  // unfiltered one above, so react-query dedupes to a single fetch; a filter adds
  // the profileId key segment and re-queries server-side (?profileId).
  const { data: lessons = [], isLoading } = useQuery<MemoryLesson[]>({
    queryKey: profileId ? ['memory', 'lessons', status, profileId] : ['memory', 'lessons', status],
    queryFn: () => api.memory.lessons(profileId ? { status, profileId } : { status }),
  })

  // The durable profile roster — feeds the filter with EVERY dispatchable lead so each one
  // is selectable even before it has proposed a single lesson (F-081). Fetched once; graceful
  // [] if it fails (options then fall back to just the proposing profiles below).
  const { data: roster = [] } = useQuery<AgentProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api.profiles.list(),
  })

  // Filter options (F-081): the lead ROSTER first — every dispatchable lead (orchestrator
  // tier, minus the generic default-orchestrator) appears even with zero lessons — then any
  // OTHER profile that actually proposed a lesson (K/Chief/…), so their lessons stay
  // filterable. Null-profile (org-blind) lessons are omitted by design (no pseudo-filter).
  const profileOptions = (() => {
    const seen = new Map<string, string>()
    for (const p of roster) {
      if (p.tier === 'orchestrator' && p.id !== 'default-orchestrator') seen.set(p.id, p.name)
    }
    for (const l of allLessons) {
      if (l.profileId != null && !seen.has(l.profileId)) {
        seen.set(l.profileId, l.profileName ?? l.profileId)
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  })()

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

      {/* Status tabs + the proposing-profile filter (server-side ?profileId). */}
      <div className="mt-4 flex items-center gap-2">
        <div className="flex-1">
          <SegControl<LessonStatus>
            ariaLabel="Lesson status"
            options={STATUS_TABS.map(t => ({ label: t.label, value: t.id }))}
            value={status}
            onChange={setStatus}
          />
        </div>
        <select
          data-testid="memory-profile-filter"
          aria-label="Filter by proposing profile"
          value={profileId}
          onChange={e => setProfileId(e.target.value)}
          className="flex-shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--muted)]"
        >
          <option value="">All profiles</option>
          {profileOptions.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
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
