import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DiffPayload, ReviewComment } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import DiffViewer from './DiffViewer'
import VerifyChip from './VerifyChip'
import ImpactPanel from './ImpactPanel'
import ConfirmDialog from './ConfirmDialog'
import Toast from './Toast'
import { groupByDir } from '../lib/review'

export interface ReviewDeckProps { runId: string; projectId: string | null }

export default function ReviewDeck({ runId, projectId }: ReviewDeckProps) {
  const qc = useQueryClient()
  const { data: diff, isLoading, error } = useQuery<DiffPayload>({
    queryKey: ['run-diff', runId],
    queryFn: () => api.runs.diff(runId),
  })
  const { data: comments = [] } = useQuery<ReviewComment[]>({
    queryKey: ['run-comments', runId],
    queryFn: () => api.runs.comments(runId),
  })
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
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
  const groups = groupByDir(files)
  const additions = files.reduce((s, f) => s + f.additions, 0)
  const deletions = files.reduce((s, f) => s + f.deletions, 0)
  const shown = selectedFile ? files.filter(f => f.path === selectedFile) : files

  return (
    <div data-testid="review-deck" className="flex-1 min-h-0 flex flex-col">
      {/* Deck header: metric chips + verify chip + actions */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-[var(--border)] flex-shrink-0">
        <span className="text-xs px-2 py-0.5 rounded font-medium bg-[var(--raised)] border border-[var(--border)] text-[var(--muted)]">
          {files.length} files · <span className="text-[var(--green)]">+{additions}</span> <span className="text-[var(--red)]">−{deletions}</span>
        </span>
        {diff?.truncated && (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber/15 text-[var(--amber)]">truncated</span>
        )}
        <VerifyChip runId={runId} />
        <div className="flex-1" />
        <button
          data-testid="deck-request-changes"
          disabled={drafts.length === 0}
          onClick={() => { setActionError(null); setConfirmAction('request') }}
          className="text-xs px-2.5 py-1 rounded font-semibold bg-amber/20 text-[var(--amber)] hover:bg-amber/30 disabled:opacity-40 transition-colors"
        >
          Request changes ({drafts.length})
        </button>
        <button
          data-testid="deck-approve"
          disabled={files.length === 0}
          onClick={() => { setActionError(null); setConfirmAction('approve') }}
          className="text-xs px-2.5 py-1 rounded font-semibold bg-green/20 text-[var(--green)] hover:bg-green/30 disabled:opacity-40 transition-colors"
        >
          Approve → PR
        </button>
      </div>

      {isLoading && <p className="p-5 text-xs text-[var(--muted)]">Loading diff…</p>}
      {error != null && <p className="p-5 text-xs text-[var(--red)]">{String((error as Error).message)}</p>}
      {!isLoading && error == null && files.length === 0 && (
        <p className="p-5 text-xs text-[var(--muted)]">No checkpointed changes.</p>
      )}

      {files.length > 0 && (
        <div className="flex-1 min-h-0 flex">
          {/* File tree aside */}
          <aside className="w-56 flex-shrink-0 overflow-y-auto border-r border-[var(--border)] py-2" data-testid="deck-file-tree">
            <button onClick={() => setSelectedFile(null)}
              className="w-full text-left px-3 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]">
              All files
            </button>
            {groups.map(g => (
              <div key={g.dir || '(root)'}>
                <p className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)] truncate">
                  {g.dir || '(root)'}
                </p>
                {g.files.map(f => (
                  <button key={f.path} onClick={() => setSelectedFile(f.path)}
                    className={`w-full text-left px-3 py-1 text-xs truncate transition-colors ${
                      selectedFile === f.path ? 'text-[var(--text)] bg-[var(--raised)]' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
                    {f.path.slice(g.dir ? g.dir.length + 1 : 0)}
                    <span className="ml-1 text-[10px]"><span className="text-[var(--green)]">+{f.additions}</span> <span className="text-[var(--red)]">−{f.deletions}</span></span>
                  </button>
                ))}
              </div>
            ))}
          </aside>
          {/* Diff + impact */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            <ImpactPanel runId={runId} projectId={projectId} />
            <DiffViewer
              files={shown}
              comments={comments}
              readOnly={false}
              onAddComment={(a) => addComment.mutate(a)}
              onDeleteComment={(id) => deleteComment.mutate(id)}
            />
          </div>
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
