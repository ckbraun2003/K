/**
 * E-02 — the plan park surface inside RunConsole (mounted at W0 when
 * run.status === 'awaiting_plan'). Structured render (steps/files/risk), full
 * structured edit (last-wins PATCH), approve/discard behind ConfirmDialogs.
 * Degraded plans (plan=null — the model skipped the fenced json) render raw
 * text honestly: edit disabled, approve still allowed.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlanDoc, RunPlan } from '@k/shared'
import { api } from '../lib/api'
import ConfirmDialog from './ConfirmDialog'
import Toast from './Toast'

const RISK_CLS: Record<PlanDoc['risk'], string> = {
  low: 'bg-green/15 text-[var(--green)]',
  medium: 'bg-amber/20 text-[var(--amber)]',
  high: 'bg-red/15 text-[var(--red)]',
}

export default function PlanCard({ runId }: { runId: string }) {
  const qc = useQueryClient()
  const { data: plan } = useQuery<RunPlan | null>({
    queryKey: ['run-plan', runId],
    // Absence-tolerant (VerifyChip idiom): the row may lag the run_update by a tick.
    queryFn: async () => { try { return await api.runs.plan(runId) } catch { return null } },
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<PlanDoc | null>(null)
  // Files are edited as RAW textarea text and normalized (split/trim/filter) only at
  // save — normalizing on every keystroke would swallow the Enter that starts a new
  // line (the blank trailing entry gets filtered out) and merge paths together.
  const [filesText, setFilesText] = useState('')
  const [confirm, setConfirm] = useState<'approve' | 'discard' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (doc: PlanDoc) => api.runs.updatePlan(runId, doc),
    onSuccess: () => {
      setEditing(false); setDraft(null); setFilesText(''); setToast('Plan updated')
      void qc.invalidateQueries({ queryKey: ['run-plan', runId] })
    },
    onError: (e) => setToast(`Save failed: ${e instanceof Error ? e.message : 'error'}`),
  })
  const approve = useMutation({
    mutationFn: () => api.runs.approvePlan(runId),
    onSuccess: () => {
      setConfirm(null); setToast('Plan approved — run resumed')
      void qc.invalidateQueries({ queryKey: ['run', runId] })
      void qc.invalidateQueries({ queryKey: ['runs'] })
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : 'approve failed'),
  })
  const discard = useMutation({
    mutationFn: () => api.runs.discardPlan(runId),
    onSuccess: () => {
      setConfirm(null); setToast('Plan discarded')
      void qc.invalidateQueries({ queryKey: ['run', runId] })
      void qc.invalidateQueries({ queryKey: ['runs'] })
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : 'discard failed'),
  })

  if (!plan) return null
  const doc = editing ? draft : plan.plan

  function startEdit() {
    if (!plan?.plan) return
    setDraft(JSON.parse(JSON.stringify(plan.plan)) as PlanDoc)
    setFilesText((plan.plan.files ?? []).join('\n'))
    setEditing(true)
  }
  function patchStep(i: number, field: 'title' | 'detail', value: string) {
    // title is a REQUIRED string — never collapse it to undefined (that would crash the
    // Save disabled guard's .trim()); only the optional detail collapses empty → undefined.
    setDraft(d => d && {
      ...d,
      steps: d.steps.map((s, j) =>
        j !== i ? s : field === 'title' ? { ...s, title: value } : { ...s, detail: value || undefined },
      ),
    })
  }

  return (
    <div data-testid="plan-card" className="flex-shrink-0 border-t border-[var(--border)] px-5 py-3 space-y-2 max-h-[45%] overflow-y-auto">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-[var(--amber)]">⏸ Plan ready — review before it implements.</p>
        {plan.plan && (
          <span data-testid="plan-risk" className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${RISK_CLS[plan.plan.risk]}`}>
            {plan.plan.risk} risk
          </span>
        )}
        {plan.edited && <span className="text-[10px] text-[var(--muted)]">edited</span>}
        <div className="ml-auto flex items-center gap-2">
          {!editing ? (
            <>
              <button type="button" data-testid="plan-edit" disabled={!plan.plan} onClick={startEdit}
                className="text-xs px-2.5 py-1 rounded font-semibold bg-amber/20 text-[var(--amber)] hover:bg-amber/30 disabled:opacity-40 transition-colors">
                Edit plan
              </button>
              <button type="button" data-testid="plan-discard" onClick={() => { setActionError(null); setConfirm('discard') }}
                className="text-xs px-2.5 py-1 rounded font-semibold bg-red/15 text-[var(--red)] hover:bg-red/25 transition-colors">
                Discard
              </button>
              <button type="button" data-testid="plan-approve" onClick={() => { setActionError(null); setConfirm('approve') }}
                className="text-xs px-2.5 py-1 rounded font-semibold bg-green/20 text-[var(--green)] hover:bg-green/30 transition-colors">
                Approve → run
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => { setEditing(false); setDraft(null); setFilesText('') }}
                className="text-xs px-2.5 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] transition-colors">
                Cancel
              </button>
              <button type="button" data-testid="plan-save" disabled={save.isPending || !draft || draft.steps.some(s => !(s.title ?? '').trim())}
                onClick={() => draft && save.mutate({ ...draft, files: filesText.split('\n').map(f => f.trim()).filter(Boolean) })}
                className="text-xs px-2.5 py-1 rounded font-semibold bg-accent/20 text-[var(--accent-hover)] hover:bg-accent/30 disabled:opacity-40 transition-colors">
                {save.isPending ? 'Saving…' : 'Save plan'}
              </button>
            </>
          )}
        </div>
      </div>

      {doc ? (
        <div className="space-y-2">
          <ol className="space-y-1">
            {doc.steps.map((s, i) => (
              <li key={i} data-testid={`plan-step-${i}`} className="flex items-start gap-2 text-xs text-[var(--text)]">
                <span className="mono text-[10px] text-[var(--muted)] mt-0.5">{i + 1}.</span>
                {editing ? (
                  <span className="flex-1 space-y-1">
                    <input value={s.title} onChange={e => patchStep(i, 'title', e.target.value)} aria-label={`Step ${i + 1} title`}
                      className="glow-focus w-full rounded-control border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none" />
                    <input value={s.detail ?? ''} onChange={e => patchStep(i, 'detail', e.target.value)} placeholder="detail (optional)" aria-label={`Step ${i + 1} detail`}
                      className="w-full rounded-control border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)] outline-none" />
                    <button type="button" onClick={() => setDraft(d => d && { ...d, steps: d.steps.filter((_, j) => j !== i) })}
                      disabled={doc.steps.length <= 1}
                      className="text-[10px] text-[var(--muted)] hover:text-[var(--red)] disabled:opacity-40">remove step</button>
                  </span>
                ) : (
                  <span className="flex-1">
                    <span className="font-medium">{s.title}</span>
                    {s.detail && <span className="text-[var(--muted)]"> — {s.detail}</span>}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {editing && (
            <button type="button" onClick={() => setDraft(d => d && { ...d, steps: [...d.steps, { title: '' }] })}
              className="text-[11px] text-[var(--accent-hover)] hover:underline">+ add step</button>
          )}
          {editing ? (
            <div className="flex items-center gap-3">
              <label className="text-[11px] text-[var(--muted)]">
                Files (one per line)
                <textarea value={filesText} rows={Math.min(4, filesText.split('\n').length + 1)}
                  onChange={e => setFilesText(e.target.value)}
                  className="mono block w-72 mt-1 rounded-control border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text)] outline-none" />
              </label>
              <label className="text-[11px] text-[var(--muted)]">
                Risk
                <select value={draft!.risk} onChange={e => setDraft(d => d && { ...d, risk: e.target.value as PlanDoc['risk'] })}
                  className="block mt-1 rounded-control border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]">
                  <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                </select>
              </label>
            </div>
          ) : (
            doc.files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {doc.files.map(f => (
                  <span key={f} className="mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] text-[var(--muted)]">{f}</span>
                ))}
              </div>
            )
          )}
          {!editing && doc.notes && <p className="text-[11px] text-[var(--muted)]">{doc.notes}</p>}
        </div>
      ) : (
        // Degraded: the model skipped the fenced json — show its words verbatim.
        <pre data-testid="plan-raw" className="mono whitespace-pre-wrap text-[11px] text-[var(--muted)] max-h-40 overflow-y-auto">{plan.raw}</pre>
      )}

      <ConfirmDialog
        open={confirm === 'approve'}
        title="Approve plan"
        message={plan.plan ? `Resume the run to execute ${plan.plan.steps.length} step${plan.plan.steps.length === 1 ? '' : 's'} (${plan.plan.risk} risk)${plan.edited ? ' — your edits will be sent as the plan of record' : ''}.` : 'Resume the run to execute its freeform plan.'}
        confirmLabel="Approve"
        busy={approve.isPending}
        error={actionError ?? undefined}
        testid="plan-approve-dialog"
        onConfirm={() => approve.mutate()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        title="Discard plan"
        message="Kill the parked run and remove its worktree. The plan text is kept as history."
        confirmLabel="Discard"
        busy={discard.isPending}
        error={actionError ?? undefined}
        testid="plan-discard-dialog"
        onConfirm={() => discard.mutate()}
        onCancel={() => setConfirm(null)}
      />
      <Toast open={toast != null} message={toast ?? ''} resetKey={toast ?? undefined} onDismiss={() => setToast(null)} />
    </div>
  )
}
