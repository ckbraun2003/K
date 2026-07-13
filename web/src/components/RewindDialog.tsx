import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import Toast from './Toast'

export interface RewindDialogProps {
  runId: string
  checkpoint: { sha: string; wave: number } | null
  onClose: () => void
}

export default function RewindDialog({ runId, checkpoint, onClose }: RewindDialogProps) {
  const [prompt, setPrompt] = useState('')
  const [toastRun, setToastRun] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const rewind = useMutation({
    mutationFn: () => api.runs.rewind(runId, { sha: checkpoint!.sha, prompt }),
    onSuccess: (run) => { setToastRun(run.id); setPrompt(''); onClose() },
  })
  // Idempotence guard: a real Escape keypress bubbles target -> document ->
  // window, so it is seen by BOTH the window listener below AND Radix's own
  // document-level Escape handler (-> onOpenChange(false) -> close()) — two
  // paths, one keypress. Route every close path through this single guarded
  // helper so only the first one fires `onClose`; reset on (re)open below.
  const closedRef = useRef(false)
  const close = () => {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }
  // Escape closes while the dialog is open — Dialog/Radix already maps ESC to
  // onOpenChange(false) (wired to close() below), but that relies on Radix's
  // own document-level listener, which a keydown dispatched directly on
  // `window` never reaches (its propagation path is just [window], it never
  // bubbles through `document`). Keep this window listener as the
  // load-bearing mechanism — same convention as before the Dialog migration.
  useEffect(() => {
    if (!checkpoint) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [checkpoint, onClose])
  // Fresh compose per open: the dialog is a PERSISTENT instance in RunTimeline
  // (only the checkpoint prop toggles null/non-null), so a draft prompt or a
  // failed-dispatch error would otherwise bleed into the next checkpoint's
  // dialog (review-caught HIGH). Also focuses the prompt on open (house
  // convention: dialogs focus into themselves) — deferred via rAF so it wins
  // against Radix's own cascading mount auto-focus (see ConfirmDialog for why
  // a plain same-tick effect isn't reliably ordered after it).
  const resetRewind = rewind.reset
  const openSha = checkpoint?.sha
  useEffect(() => {
    if (!openSha) return
    setPrompt('')
    resetRewind()
    closedRef.current = false
    const raf = requestAnimationFrame(() => promptRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [openSha, resetRewind])
  if (!checkpoint && toastRun === null) return null
  return (
    <>
      {checkpoint && (
        <Dialog
          open
          onOpenChange={(o) => { if (!o) close() }}
          title="Rewind & re-dispatch"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="rewind-dispatch"
                disabled={prompt.trim() === '' || rewind.isPending}
                onClick={() => rewind.mutate()}
              >
                {rewind.isPending ? 'Dispatching…' : 'Dispatch from checkpoint'}
              </Button>
            </>
          }
        >
          {/* Mirrors the pre-Dialog backdrop/card split (outer closes, inner
              stops) purely for the DOM/testid contract consumer tests assert
              on — the real dismiss affordance is Dialog's own Radix overlay. */}
          <div data-testid="rewind-dialog" onClick={close}>
            <div onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 pb-2">
                <span className="text-micro px-1.5 py-0.5 rounded bg-accent/15 text-accent-hover font-mono">
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
                className="w-full h-24 rounded-control border border-border bg-raised p-2 text-body text-text resize-none"
              />
              {rewind.isError && (
                <p className="pt-1 text-caption text-red">{(rewind.error as Error).message}</p>
              )}
            </div>
          </div>
        </Dialog>
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
