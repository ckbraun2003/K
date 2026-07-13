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
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Tag } from '../ui/Tag'
import { Input, Textarea, Select } from '../ui/Field'

// Risk level is NOT a canonical Run status — StatusPill doesn't cover it, so
// this stays a bespoke semantic-token-tinted span (not Tag: green/amber/red
// aren't in Tag's tint palette).
const RISK_CLS: Record<PlanDoc['risk'], string> = {
  low: 'bg-green/15 text-green',
  medium: 'bg-amber/20 text-amber',
  high: 'bg-red/15 text-red',
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
    <div
      data-testid="plan-card"
      // Glass-panel card (top-level flex child of RunConsole, same tier as the
      // HITL answer box — not nested inside another glass ancestor). Amber
      // border ties it to the "needs review" semantics (matches StatusPill's
      // awaiting_plan color).
      className="glass-panel flex-shrink-0 mx-5 mb-3 border-amber/25 px-5 py-3 space-y-2 max-h-[45%] overflow-y-auto"
    >
      <div className="flex items-center gap-2">
        <p className="flex items-center gap-1.5 text-label font-medium text-amber">
          <Icon name="warning" size={14} />
          Plan ready — review before it implements.
        </p>
        {plan.plan && (
          <span data-testid="plan-risk" className={`text-micro px-1.5 py-0.5 rounded font-semibold ${RISK_CLS[plan.plan.risk]}`}>
            {plan.plan.risk} risk
          </span>
        )}
        {plan.edited && <span className="text-micro text-muted">edited</span>}
        <div className="ml-auto flex items-center gap-2">
          {!editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                data-testid="plan-edit"
                disabled={!plan.plan}
                onClick={startEdit}
                className="bg-amber/20 text-amber hover:bg-amber/30 hover:text-amber"
              >
                Edit plan
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="plan-discard"
                onClick={() => { setActionError(null); setConfirm('discard') }}
              >
                Discard
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="plan-approve"
                onClick={() => { setActionError(null); setConfirm('approve') }}
                className="bg-green/20 text-green hover:bg-green/30 hover:text-green"
              >
                Approve → run
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border"
                onClick={() => { setEditing(false); setDraft(null); setFilesText('') }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="plan-save"
                disabled={save.isPending || !draft || draft.steps.some(s => !(s.title ?? '').trim())}
                onClick={() => draft && save.mutate({ ...draft, files: filesText.split('\n').map(f => f.trim()).filter(Boolean) })}
              >
                {save.isPending ? 'Saving…' : 'Save plan'}
              </Button>
            </>
          )}
        </div>
      </div>

      {doc ? (
        <div className="space-y-2">
          <ol className="space-y-1">
            {doc.steps.map((s, i) => (
              <li key={i} data-testid={`plan-step-${i}`} className="flex items-start gap-2 text-label text-text">
                <span className="mono tabular-nums text-micro text-muted mt-0.5">{i + 1}.</span>
                {editing ? (
                  <span className="flex-1 space-y-1">
                    <Input
                      value={s.title}
                      onChange={e => patchStep(i, 'title', e.target.value)}
                      aria-label={`Step ${i + 1} title`}
                      className="w-full"
                    />
                    <Input
                      value={s.detail ?? ''}
                      onChange={e => patchStep(i, 'detail', e.target.value)}
                      placeholder="detail (optional)"
                      aria-label={`Step ${i + 1} detail`}
                      className="w-full text-caption text-muted"
                    />
                    <button
                      type="button"
                      onClick={() => setDraft(d => d && { ...d, steps: d.steps.filter((_, j) => j !== i) })}
                      disabled={doc.steps.length <= 1}
                      className="text-micro text-muted hover:text-red disabled:opacity-40"
                    >
                      remove step
                    </button>
                  </span>
                ) : (
                  <span className="flex-1">
                    <span className="font-medium">{s.title}</span>
                    {s.detail && <span className="text-muted"> — {s.detail}</span>}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {editing && (
            <button
              type="button"
              onClick={() => setDraft(d => d && { ...d, steps: [...d.steps, { title: '' }] })}
              className="text-caption text-accent-hover hover:underline"
            >
              + add step
            </button>
          )}
          {editing ? (
            <div className="flex items-center gap-3">
              <label className="text-caption text-muted">
                Files (one per line)
                <Textarea
                  value={filesText}
                  rows={Math.min(4, filesText.split('\n').length + 1)}
                  onChange={e => setFilesText(e.target.value)}
                  className="mono block w-72 mt-1 text-caption"
                />
              </label>
              <label className="text-caption text-muted">
                Risk
                <Select
                  value={draft!.risk}
                  onChange={e => setDraft(d => d && { ...d, risk: e.target.value as PlanDoc['risk'] })}
                  className="block mt-1 text-label"
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </label>
            </div>
          ) : (
            doc.files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {doc.files.map(f => (
                  <Tag key={f} tint="neutral" className="mono">{f}</Tag>
                ))}
              </div>
            )
          )}
          {!editing && doc.notes && <p className="text-caption text-muted">{doc.notes}</p>}
        </div>
      ) : (
        // Degraded: the model skipped the fenced json — show its words verbatim.
        <pre data-testid="plan-raw" className="mono whitespace-pre-wrap text-caption text-muted max-h-40 overflow-y-auto">{plan.raw}</pre>
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
