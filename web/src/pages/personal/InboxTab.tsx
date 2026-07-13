import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { InboxItem, InboxItemKind } from '@k/shared'
import { INBOX_KEY, inboxQueryFn, EMPTY_INBOX } from '../../lib/inbox-query'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { relativeTime } from '../../lib/verify'
import Toast from '../../components/Toast'

// Render order + section headings — plans/replies first (they hold a live process),
// then review, then the async approve queues (lessons, MCP trust).
const SECTION_ORDER: InboxItemKind[] = ['plan_pending', 'input_needed', 'review_ready', 'proposal', 'lesson_pending', 'mcp_trust']
const SECTION_LABEL: Record<InboxItemKind, string> = {
  plan_pending: 'Plans to approve', input_needed: 'Runs waiting on your reply',
  review_ready: 'Ready for review', proposal: 'Proposals to approve',
  lesson_pending: 'Lessons to approve', mcp_trust: 'MCP servers to trust',
}

// Shared button shells — filled accents carry dark ink (text-[var(--bg)]) for contrast
// on the bright green/amber tokens; the secondary is an outlined amber (destructive-ish).
const BTN_PRIMARY = 'rounded-lg bg-[var(--green)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50'
const BTN_SECONDARY = 'rounded-lg border border-[var(--amber)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--amber)] transition-colors hover:bg-amber/15 disabled:opacity-50'
const BTN_NEUTRAL = 'rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[var(--accent)]'

interface Handlers {
  approveLesson: (lessonId: string) => void
  rejectLesson: (lessonId: string) => void
  trustMcp: (qualifiedKey: string) => void
  dismissMcp: (qualifiedKey: string) => void
  dismissReview: (runId: string) => void
  approveProposal: (workItemId: string) => void
  dismissProposal: (workItemId: string) => void
  busy: boolean
}

// E-14 source chip labels — short, deterministic (no prose).
const PROPOSAL_SOURCE_LABEL: Record<string, string> = {
  ci_failed: 'CI', verify_finding: 'Verify', open_issue: 'Issue', stale_bible: 'Bible',
}

export default function InboxTab() {
  const qc = useQueryClient()
  const [toast, setToast] = useState<string | null>(null)
  // The ONE shared inbox query (rail badge + this page key off it, so the page adds
  // zero extra fetches — inbox-query.ts). Undefined while loading → EMPTY (zero state).
  const { data } = useQuery({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const box = data ?? EMPTY_INBOX

  const fail = (verb: string) => (e: unknown) => setToast(`${verb} failed: ${(e as Error).message}`)
  const refreshInbox = () => { void qc.invalidateQueries({ queryKey: INBOX_KEY }) }

  // Lesson approve/reject also move the lead's memory lists — invalidate the ['profile-memory']
  // prefix (OrchestratorDetailPage's per-lead pending/accepted/rejected tabs) so an approve/reject
  // here reflects there live. (The retired MemoryPage's ['memory','lessons'] key has zero readers
  // at HEAD, so invalidating it did nothing.)
  const approveLesson = useMutation({
    mutationFn: (lessonId: string) => api.memory.approve(lessonId),
    onSuccess: () => { refreshInbox(); void qc.invalidateQueries({ queryKey: ['profile-memory'] }) },
    onError: fail('Approve'),
  })
  const rejectLesson = useMutation({
    mutationFn: (lessonId: string) => api.memory.reject(lessonId),
    onSuccess: () => { refreshInbox(); void qc.invalidateQueries({ queryKey: ['profile-memory'] }) },
    onError: fail('Reject'),
  })
  // MCP trust/dismiss cross into the capability catalog → also invalidate ['capabilities'].
  const trustMcp = useMutation({
    mutationFn: (qualifiedKey: string) => api.capabilities.trustMcp(qualifiedKey),
    onSuccess: () => { refreshInbox(); void qc.invalidateQueries({ queryKey: ['capabilities'] }) },
    onError: fail('Trust'),
  })
  const dismissMcp = useMutation({
    mutationFn: (qualifiedKey: string) => api.inbox.dismissMcp(qualifiedKey),
    onSuccess: () => { refreshInbox(); void qc.invalidateQueries({ queryKey: ['capabilities'] }) },
    onError: fail('Dismiss'),
  })
  const dismissReview = useMutation({
    mutationFn: (runId: string) => api.inbox.dismissReview(runId),
    onSuccess: refreshInbox,
    onError: fail('Dismiss'),
  })
  // E-14 — approve enters the auto-pull backlog (open); dismiss is sticky (cancelled).
  // Both are single-click, compose-is-confirm actions. Dismiss is PERMANENT for
  // project-keyed sources: ci_failed / verify_finding / stale_bible derive their
  // source_key from the project, so a sticky-dismiss suppresses that signal for good —
  // the accepted "don't nag again" design (proposal-collectors.ts). Only open_issue is
  // issue-number-keyed, so a genuinely NEW issue re-proposes under its own key; a
  // dismissed project-keyed signal never re-surfaces on its own (no collector "undo").
  const approveProposal = useMutation({
    mutationFn: (id: string) => api.inbox.approveProposal(id),
    onSuccess: refreshInbox,
    onError: fail('Approve'),
  })
  const dismissProposal = useMutation({
    mutationFn: (id: string) => api.inbox.dismissProposal(id),
    onSuccess: refreshInbox,
    onError: fail('Dismiss'),
  })

  const handlers: Handlers = {
    approveLesson: id => approveLesson.mutate(id),
    rejectLesson: id => rejectLesson.mutate(id),
    trustMcp: key => trustMcp.mutate(key),
    dismissMcp: key => dismissMcp.mutate(key),
    dismissReview: id => dismissReview.mutate(id),
    approveProposal: id => approveProposal.mutate(id),
    dismissProposal: id => dismissProposal.mutate(id),
    busy: approveLesson.isPending || rejectLesson.isPending || trustMcp.isPending || dismissMcp.isPending ||
      dismissReview.isPending || approveProposal.isPending || dismissProposal.isPending,
  }

  return (
    <div data-testid="inbox-page" className="h-full overflow-y-auto p-5">
      {box.total === 0 ? (
        <div
          data-testid="inbox-zero"
          className="flex flex-1 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] py-16 text-sm text-[var(--muted)]"
        >
          Inbox zero — nothing needs you.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {SECTION_ORDER.map(kind => {
            const count = box.counts[kind]
            if (count === 0) return null
            const items = box.items.filter(i => i.kind === kind)
            return (
              <section key={kind} data-testid={`inbox-section-${kind}`}>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    {SECTION_LABEL[kind]}
                  </h2>
                  <span className="rounded-full bg-[var(--raised)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                    {count}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {items.map(item => (
                    <InboxCard key={item.id} item={item} handlers={handlers} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <Toast open={toast !== null} testid="inbox-toast" message={toast ?? ''} onDismiss={() => setToast(null)} />
    </div>
  )
}

// ── One inbox row card (LessonCard look: left = title + subtitle, right = actions) ──

function InboxCard({ item, handlers }: { item: InboxItem; handlers: Handlers }) {
  return (
    <div
      data-testid={`inbox-card-${item.id}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[var(--text)]" title={item.title}>{item.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--muted)]">
          <span>{item.projectName ?? '—'}</span>
          <span>· {relativeTime(item.ts)}</span>
          <CardMeta item={item} />
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <CardActions item={item} handlers={handlers} />
      </div>
    </div>
  )
}

// Kind-specific hint chips (right of the subtitle).
function CardMeta({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'plan_pending':
      return (
        <>
          {item.risk && <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">{item.risk} risk</span>}
          {item.steps != null && <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">{item.steps} steps</span>}
          {item.edited && <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">edited</span>}
        </>
      )
    case 'input_needed':
      return <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5">{item.model}</span>
    case 'review_ready':
      return item.verifyStatus ? <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">verify {item.verifyStatus}</span> : null
    case 'lesson_pending':
      return <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">{item.profileName ?? 'unassigned'}</span>
    case 'mcp_trust':
      return <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5">{item.sourceKind}</span>
    case 'proposal':
      return <span className="rounded bg-[var(--raised)] px-1.5 py-0.5">{PROPOSAL_SOURCE_LABEL[item.source] ?? item.source}</span>
  }
}

function CardActions({ item, handlers }: { item: InboxItem; handlers: Handlers }) {
  switch (item.kind) {
    case 'plan_pending':
      return (
        <button data-testid={`inbox-open-${item.id}`} onClick={() => navigate('runs', item.runId)} className={BTN_NEUTRAL}>
          Review plan
        </button>
      )
    case 'input_needed':
      return (
        <button data-testid={`inbox-open-${item.id}`} onClick={() => navigate('runs', item.runId)} className={BTN_NEUTRAL}>
          Reply
        </button>
      )
    case 'review_ready':
      return (
        <>
          <button data-testid={`inbox-open-${item.id}`} onClick={() => navigate('runs', item.runId)} className={BTN_NEUTRAL}>
            Open review
          </button>
          <button
            data-testid={`inbox-dismiss-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.dismissReview(item.runId)}
            className={BTN_SECONDARY}
          >
            Dismiss
          </button>
        </>
      )
    case 'lesson_pending':
      return (
        <>
          <button
            data-testid={`inbox-approve-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.approveLesson(item.lessonId)}
            className={BTN_PRIMARY}
          >
            ✓ Approve
          </button>
          <button
            data-testid={`inbox-dismiss-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.rejectLesson(item.lessonId)}
            className={BTN_SECONDARY}
          >
            Reject
          </button>
        </>
      )
    case 'mcp_trust':
      return (
        <>
          <button
            data-testid={`inbox-approve-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.trustMcp(item.qualifiedKey)}
            className={BTN_PRIMARY}
          >
            Trust
          </button>
          <button
            data-testid={`inbox-dismiss-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.dismissMcp(item.qualifiedKey)}
            className={BTN_SECONDARY}
          >
            Dismiss
          </button>
        </>
      )
    case 'proposal':
      return (
        <>
          <button
            data-testid={`inbox-approve-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.approveProposal(item.workItemId)}
            className={BTN_PRIMARY}
          >
            ✓ Approve
          </button>
          <button
            data-testid={`inbox-dismiss-${item.id}`}
            disabled={handlers.busy}
            onClick={() => handlers.dismissProposal(item.workItemId)}
            className={BTN_SECONDARY}
          >
            Dismiss
          </button>
        </>
      )
  }
}
