import { useEffect, useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { useFocusTrap } from '../lib/useFocusTrap'
import Toast from './Toast'

export interface RewindDialogProps {
  runId: string
  checkpoint: { sha: string; wave: number } | null
  onClose: () => void
}

export default function RewindDialog({ runId, checkpoint, onClose }: RewindDialogProps) {
  const [prompt, setPrompt] = useState('')
  const [toastRun, setToastRun] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const headingId = useId()
  const rewind = useMutation({
    mutationFn: () => api.runs.rewind(runId, { sha: checkpoint!.sha, prompt }),
    onSuccess: (run) => { setToastRun(run.id); setPrompt(''); onClose() },
  })
  // a11y: keep Tab/Shift+Tab cycling inside the modal while it's open (house
  // dialog convention — see ConfirmDialog).
  useFocusTrap(cardRef, !!checkpoint)
  // Escape closes while the dialog is open (window listener — the overlay holds
  // no focus, so a keydown handler on the div would never fire).
  useEffect(() => {
    if (!checkpoint) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [checkpoint, onClose])
  // Fresh compose per open: the dialog is a PERSISTENT instance in RunTimeline
  // (only the checkpoint prop toggles null/non-null), so a draft prompt or a
  // failed-dispatch error would otherwise bleed into the next checkpoint's
  // dialog (review-caught HIGH). Also focuses the prompt on open (house
  // convention: dialogs focus into themselves).
  const resetRewind = rewind.reset
  const openSha = checkpoint?.sha
  useEffect(() => {
    if (!openSha) return
    setPrompt('')
    resetRewind()
    promptRef.current?.focus()
  }, [openSha, resetRewind])
  if (!checkpoint && toastRun === null) return null
  return (
    <>
      {checkpoint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="rewind-dialog"
          onClick={onClose}>
          <div ref={cardRef} role="dialog" aria-modal="true" aria-labelledby={headingId}
            className="w-[28rem] max-w-[90vw] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 pb-2">
              <h3 id={headingId} className="text-sm font-semibold text-[var(--text)]">Rewind &amp; re-dispatch</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-[var(--accent-hover)] font-mono">
                wave {checkpoint.wave} · {checkpoint.sha.slice(0, 10)}
              </span>
            </div>
            <textarea
              ref={promptRef}
              data-testid="rewind-prompt"
              aria-label="Rewind prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="What should the follow-up run do from this state?"
              className="w-full h-24 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-2 text-sm text-[var(--text)] resize-none"
            />
            {rewind.isError && (
              <p className="pt-1 text-xs text-[var(--red)]">{(rewind.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2 pt-3">
              <button onClick={onClose} className="text-xs px-2.5 py-1 rounded text-[var(--muted)] hover:text-[var(--text)]">Cancel</button>
              <button
                data-testid="rewind-dispatch"
                disabled={prompt.trim() === '' || rewind.isPending}
                onClick={() => rewind.mutate()}
                className="text-xs px-2.5 py-1 rounded font-semibold bg-[var(--accent)] text-black disabled:opacity-40"
              >
                {rewind.isPending ? 'Dispatching…' : 'Dispatch from checkpoint'}
              </button>
            </div>
          </div>
        </div>
      )}
      <Toast
        open={toastRun !== null}
        message="Rewound run dispatched"
        testid="rewind-toast"
        resetKey={toastRun ?? undefined}
        action={toastRun ? { label: 'View run', onClick: () => navigate('runs', toastRun) } : undefined}
        onDismiss={() => setToastRun(null)}
      />
    </>
  )
}
