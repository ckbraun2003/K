import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DiffPayload, ReviewComment } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import ChangesLayout from './ChangesLayout'
import VerifyChip from './VerifyChip'
import ImpactPanel from './ImpactPanel'
import ConfirmDialog from './ConfirmDialog'
import Toast from './Toast'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

export interface ReviewDeckProps { runId: string; projectId: string | null }

export default function ReviewDeck({ runId, projectId }: ReviewDeckProps) {
  const qc = useQueryClient()
  // FE-5 IN-7: whole-diff expand bumps context 3→24 on first "Expand context"
  // click (checkpoint runs only — PRs never pass onExpandFile).
  const [context, setContext] = useState(3)
  const { data: diff, isLoading, error } = useQuery<DiffPayload>({
    queryKey: ['run-diff', runId, context],
    queryFn: () => api.runs.diff(runId, context),
  })
  const { data: comments = [] } = useQuery<ReviewComment[]>({
    queryKey: ['run-comments', runId],
    queryFn: () => api.runs.comments(runId),
  })
  const [confirmAction, setConfirmAction] = useState<'request' | 'approve' | null>(null)
  const [toast, setToast] = useState<{ msg: string; runId?: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Comment mutations surface failures via Toast (quality-review HIGH): the
  // inline composer closes optimistically, so a silent error would drop the
  // operator's comment with zero feedback.
  const addComment = useMutation({
    mutationFn: (a: { file: string; line: number | null; side: 'old' | 'new'; body: string }) =>
      api.runs.createComment(runId, a),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['run-comments', runId] }),
    onError: (e) => setToast({ msg: `Comment failed: ${e instanceof Error ? e.message : 'save error'}` }),
  })
  const deleteComment = useMutation({
    mutationFn: (commentId: string) => api.runs.deleteComment(runId, commentId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['run-comments', runId] }),
    onError: (e) => setToast({ msg: `Delete failed: ${e instanceof Error ? e.message : 'delete error'}` }),
  })
  const requestChanges = useMutation({
    mutationFn: () => api.runs.requestChanges(runId),
    onSuccess: (r) => {
      setConfirmAction(null)
      setToast({ msg: `Fix run dispatched (${r.commentsSent} comment${r.commentsSent === 1 ? '' : 's'})`, runId: r.run.id })
      void qc.invalidateQueries({ queryKey: ['run-comments', runId] })
      void qc.invalidateQueries({ queryKey: ['runs'] })
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : 'request failed'),
  })
  const approve = useMutation({
    mutationFn: () => api.runs.approve(runId),
    onSuccess: (r) => { setConfirmAction(null); setToast({ msg: `PR #${r.pr.number} opened from ${r.branch}` }) },
    onError: (e) => setActionError(e instanceof Error ? e.message : 'approve failed'),
  })

  const drafts = comments.filter(c => c.status === 'draft')
  const files = diff?.files ?? []
  const additions = files.reduce((s, f) => s + f.additions, 0)
  const deletions = files.reduce((s, f) => s + f.deletions, 0)

  return (
    <div data-testid="review-deck" className="flex-1 min-h-0 flex flex-col">
      {/* Deck header: metric chips + verify chip + actions */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-border flex-shrink-0">
        <span className="text-xs px-2 py-0.5 rounded font-medium bg-[var(--glass-3)] border border-[var(--glass-tier-border)] text-muted">
          {files.length} files · <span className="text-green">+{additions}</span> <span className="text-red">−{deletions}</span>
        </span>
        {diff?.truncated && (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber/15 text-amber">truncated</span>
        )}
        <VerifyChip runId={runId} />
        <div className="flex-1" />
        {files.length > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              data-testid="deck-request-changes"
              disabled={drafts.length === 0}
              onClick={() => { setActionError(null); setConfirmAction('request') }}
              className="bg-amber/20 text-amber hover:bg-amber/30 hover:text-amber"
            >
              Request changes ({drafts.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="deck-approve"
              onClick={() => { setActionError(null); setConfirmAction('approve') }}
              className="bg-green/20 text-green hover:bg-green/30 hover:text-green"
            >
              Approve → PR
            </Button>
          </>
        )}
      </div>

      {isLoading && <p className="p-5 text-xs text-muted">Loading diff…</p>}
      {error != null && <p className="p-5 text-xs text-red">{String((error as Error).message)}</p>}
      {!isLoading && error == null && files.length === 0 && (
        <EmptyState
          icon="pr"
          headline="No checkpointed changes"
          hint="Waves land here as k-checkpoint snapshots while a run works this project."
          className="p-5"
        />
      )}

      {diff && files.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col">
          <ImpactPanel runId={runId} projectId={projectId} />
          <ChangesLayout
            payload={diff}
            comments={comments}
            readOnly={false}
            onAddComment={a => addComment.mutate(a)}
            onDeleteComment={id => deleteComment.mutate(id)}
            onExpandFile={diff.source === 'checkpoint' && context < 24 ? () => setContext(24) : undefined}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmAction === 'request'}
        title="Request changes?"
        testid="deck-request-dialog"
        busy={requestChanges.isPending}
        error={actionError ?? undefined}
        message={`Dispatch a fix run carrying the reviewed tree with ${drafts.length} comment${drafts.length === 1 ? '' : 's'} bundled.`}
        confirmLabel="Dispatch fix run"
        onConfirm={() => requestChanges.mutate()}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'approve'}
        title="Approve and open PR?"
        testid="deck-approve-dialog"
        busy={approve.isPending}
        error={actionError ?? undefined}
        message="Publishes the run's final checkpoint as a k-review/* branch and opens a PR against the project's default branch."
        confirmLabel="Approve → PR"
        onConfirm={() => approve.mutate()}
        onCancel={() => setConfirmAction(null)}
      />
      <Toast
        open={toast !== null}
        message={toast?.msg ?? ''}
        testid="deck-toast"
        resetKey={toast?.msg}
        action={toast?.runId ? { label: 'View run', onClick: () => navigate('runs', toast.runId!) } : undefined}
        onDismiss={() => setToast(null)}
      />
    </div>
  )
}
