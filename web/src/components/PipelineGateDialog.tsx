import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { PipelineRunView, PipelineStageRun } from '@k/shared'
import { api } from '../lib/api'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Field'

/** A 409 from the gate route means someone (K, a rule, another tab) already resolved
 *  it — a benign race, not an error. Surface it as a re-sync rather than a red failure. */
function isAlreadyResolved(err: unknown): boolean {
  return err instanceof Error && /already resolved/i.test(err.message)
}

/**
 * Resolve a parked pipeline gate (D-119 C3). Reuses the shared Dialog overlay
 * (Radix — same focus trap the RewindDialog uses) with an approve/reject choice and
 * an optional note → `api.pipelines.resolveGate`. A 409 (already resolved elsewhere)
 * is handled gracefully: the run is re-synced via `onConflict` and the dialog closes,
 * rather than parking the operator on a stale error.
 */
export default function PipelineGateDialog({
  open,
  runId,
  stage,
  onClose,
  onResolved,
  onConflict,
}: {
  open: boolean
  runId: string
  stage: PipelineStageRun | null
  onClose: () => void
  /** The refreshed run view a successful resolution returns. */
  onResolved: (view: PipelineRunView) => void
  /** Someone else already resolved the gate — the caller should refetch the run. */
  onConflict?: () => void
}) {
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const resolve = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api.pipelines.resolveGate(runId, stage!.id, { decision, note: note.trim() || undefined }),
    onSuccess: view => {
      setNote('')
      onResolved(view)
      onClose()
    },
    onError: err => {
      if (isAlreadyResolved(err)) {
        onConflict?.()
        onClose()
      }
      // Any other error falls through to the inline banner below.
    },
  })

  // Fresh compose per open (a stale note / error must not survive a reopen) + focus
  // the note field — the house convention (dialogs focus into themselves).
  const reset = resolve.reset
  useEffect(() => {
    if (!open) return
    setNote('')
    reset()
    const raf = requestAnimationFrame(() => noteRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, reset])

  if (!open || !stage) return null

  const conflictError = resolve.isError && !isAlreadyResolved(resolve.error)

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o && !resolve.isPending) onClose()
      }}
      title="Resolve gate"
      footer={
        <>
          <Button variant="ghost" size="sm" className="border border-border" disabled={resolve.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="close"
            data-testid="pipeline-gate-reject"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate('reject')}
          >
            Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            data-testid="pipeline-gate-approve"
            loading={resolve.isPending}
            onClick={() => resolve.mutate('approve')}
          >
            Approve
          </Button>
        </>
      }
    >
      <div data-testid="pipeline-gate-dialog">
        <p className="text-body text-text">
          Gate <span className="mono font-semibold">{stage.stageKey}</span> is parked for review.
          Approve to let the pipeline continue, or reject to fail this stage.
        </p>
        <label className="mt-3 block text-caption text-muted">
          Note (optional)
          <Textarea
            ref={noteRef}
            value={note}
            onChange={e => setNote(e.target.value)}
            data-testid="pipeline-gate-note"
            placeholder="Why approve / reject?"
            className="mt-1 w-full"
          />
        </label>
        {conflictError && (
          <p className="mt-2 text-caption text-red" data-testid="pipeline-gate-error">
            {(resolve.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  )
}
