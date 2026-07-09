/**
 * E-06 — one-click merge, gated CLIENT-side on the same checks projection the
 * server re-checks (the server readback is the real guard; this is honesty UX).
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PrInfo } from '@k/shared'
import { api } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'
import Toast from './Toast'

export default function MergeButton({ projectId, pr }: { projectId: string; pr: PrInfo }) {
  const qc = useQueryClient()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const merge = useMutation({
    mutationFn: () => api.projects.mergePr(projectId, pr.number),
    onSuccess: () => {
      setConfirmOpen(false)
      setToast(`PR #${pr.number} merged`)
      void qc.invalidateQueries({ queryKey: ['github', projectId] }) // CONFIRM the tab's exact key — read PrsCiTab first
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'merge failed'),
  })
  if (String(pr.state).toUpperCase() !== 'OPEN') return null
  const green = pr.checks === 'passing'
  return (
    <>
      <button
        type="button"
        data-testid={`pr-merge-${pr.number}`}
        disabled={!green || merge.isPending}
        title={green ? `Merge PR #${pr.number}` : `checks are ${pr.checks} — merge blocked`}
        onClick={e => { e.stopPropagation(); setError(null); setConfirmOpen(true) }}
        className="text-xs px-2.5 py-1 rounded font-semibold bg-green/20 text-[var(--green)] hover:bg-green/30 disabled:opacity-40 transition-colors"
      >
        Merge
      </button>
      {/* Both overlays render as fixed-position boxes but are CHILDREN in the React
          tree of PrsCiTab's clickable role="button" PR row. React events bubble along
          the TREE, not the DOM box, so a click on the dialog's Cancel/backdrop/Merge —
          or the Toast's dismiss button (visible after a merge, before the row refetches) —
          would otherwise reach PrRow.onClick and toggle its expand (a stray
          `gh pr diff` fetch). Stop both at the tree boundary. */}
      <span onClick={e => e.stopPropagation()}>
        <ConfirmDialog
          open={confirmOpen}
          title={`Merge PR #${pr.number}`}
          message={`Merge "${pr.title}" into the default branch? Checks are green.`}
          confirmLabel="Merge"
          busy={merge.isPending}
          error={error ?? undefined}
          testid="pr-merge-dialog"
          onConfirm={() => merge.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
        <Toast open={toast != null} message={toast ?? ''} resetKey={toast ?? undefined} onDismiss={() => setToast(null)} />
      </span>
    </>
  )
}
