import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChiefOrgPayload, Assignment, AgentRun, DelegationNode } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { relativeTime } from '../../lib/verify'
import { useAskK } from '../../lib/useAskK'
import { fullOrgToDelegationTree } from '../../lib/delegation'
import { agentRunStatusMeta } from '../../lib/status'
import DelegationTree from '../../components/DelegationTree'
import ConfirmDialog from '../../components/ConfirmDialog'
import Toast from '../../components/Toast'

/**
 * Chief org home (P5.2a read → C2 actuation) — objectives · delegation tree ·
 * autonomous-wake history, plus the operator ACTIONS that are live now: a
 * hand-Chief-work composer (a forced-route ask through the shared K front door),
 * per-objective reassign (PATCH /api/chief/assignments/:id, ConfirmDialog-gated),
 * and inspector actions on the tree (open lead / view run / stop a live lead run).
 * ONE batched query (api.chief.org) still drives all the READS: no per-item
 * useQuery fan-out.
 */

/** The slim lead option the reassign select renders (derived from payload.leads). */
interface LeadOption { id: string; name: string }

/**
 * One objective row (an Assignment) with the reassign control. Prop-fed +
 * render-testable: the row owns only its select state; confirming (the dialog,
 * the mutation) lives in ChiefPage via `onReassign`.
 */
export function ObjectiveRow({
  assignment,
  leads,
  onReassign,
}: {
  assignment: Assignment
  leads: LeadOption[]
  onReassign: (assignment: Assignment, leadProfileId: string) => void
}) {
  // Default the select to the profile matching the current lead NAME (assignments
  // store the name — see routes/chief.ts), else unselected.
  const current = leads.find(l => l.name === assignment.lead)
  const [sel, setSel] = useState(current?.id ?? '')
  // Re-seed when the lead changes UNDERNEATH the row (the Chief reassigns
  // autonomously; a chief-org background refetch delivers it): without this the
  // select keeps showing the OLD lead beside the chip showing the new one, and the
  // armed Reassign button invites an accidental revert. Also keyed on the resolved
  // option id so a late-arriving `leads` list seeds the select once it can.
  useEffect(() => { setSel(current?.id ?? '') }, [assignment.lead, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const selName = leads.find(l => l.id === sel)?.name
  const dirty = sel !== '' && selName !== assignment.lead
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2"
      data-testid={`chief-objective-${assignment.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
          {assignment.objective}
        </span>
        <span className="flex-shrink-0 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]">
          {assignment.lead}
        </span>
      </div>
      {/* Status + created-at — an objective is 'dispatched' once its lead run exists,
          else still 'pending' (F-083). */}
      <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--muted)]">
        <span
          data-testid={`chief-objective-status-${assignment.id}`}
          className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-semibold uppercase tracking-wide"
        >
          {assignment.leadRunId ? 'dispatched' : 'pending'}
        </span>
        <span data-testid={`chief-objective-created-${assignment.id}`}>
          created {relativeTime(assignment.createdAt)}
        </span>
      </div>
      {(assignment.workflow || assignment.projects.length > 0 || assignment.note) && (
        <p className="mt-1 truncate text-[11px] text-[var(--muted)]">
          {assignment.workflow && <span>workflow: {assignment.workflow}</span>}
          {assignment.workflow && assignment.projects.length > 0 && <span> · </span>}
          {assignment.projects.length > 0 && <span>projects: {assignment.projects.join(', ')}</span>}
          {!assignment.workflow && assignment.projects.length === 0 && assignment.note && (
            <span>{assignment.note}</span>
          )}
        </p>
      )}
      {/* Reassign — enabled only when the selection actually moves the lead. */}
      <div className="mt-1.5 flex items-center gap-2">
        <select
          data-testid={`chief-reassign-select-${assignment.id}`}
          aria-label="Reassign lead"
          value={sel}
          onChange={e => setSel(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
        >
          {!current && <option value="">pick a lead…</option>}
          {leads.map(l => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <button
          type="button"
          data-testid={`chief-reassign-${assignment.id}`}
          disabled={!dirty}
          onClick={() => onReassign(assignment, sel)}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-40"
        >
          Reassign
        </button>
      </div>
    </div>
  )
}

/** One autonomous-wake row (an AgentRun). Links into the run when it reached one. */
function WakeRow({ wake }: { wake: AgentRun }) {
  const statusClass = agentRunStatusMeta(wake.status).text
  return (
    <li className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-xs">
      <span className="flex-shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        {wake.trigger}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{wake.goal ?? '(no goal)'}</span>
      {wake.runId && (
        <button
          type="button"
          onClick={() => navigate('runs', wake.runId ?? undefined)}
          className="flex-shrink-0 text-[var(--accent-hover)] hover:underline"
        >
          view run
        </button>
      )}
      <span className={`flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide ${statusClass}`}>
        {wake.status}
      </span>
      <span className="flex-shrink-0 text-[10px] text-[var(--muted)]">{relativeTime(wake.createdAt)}</span>
    </li>
  )
}

export default function TreeView() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<ChiefOrgPayload>({
    queryKey: ['chief-org'],
    queryFn: () => api.chief.org(),
  })

  // Hand-Chief-work composer — the shared K front door with a FORCED chief route
  // (no classifier guessing: the caption below is static because the route is).
  const [handQuery, setHandQuery] = useState('')
  const hand = useAskK({ navigateOnSend: false })

  // Reassign confirm state — the dialog + mutation live here so ObjectiveRow stays
  // prop-fed. `reassign` holds the pending (assignment, target) pair while open.
  const [reassign, setReassign] = useState<{ assignment: Assignment; leadProfileId: string } | null>(null)
  const reassignMutation = useMutation({
    mutationFn: (v: { assignmentId: string; leadProfileId: string }) =>
      api.chief.reassign(v.assignmentId, v.leadProfileId),
    onSuccess: () => {
      setReassign(null)
      void qc.invalidateQueries({ queryKey: ['chief-org'] })
    },
    // Not swallowed — a 409 ("lead run is live" / "pending dispatch") surfaces in
    // the ConfirmDialog's error slot below.
  })

  // Stop-run confirm state (inspector action on a live lead node).
  const [stopRun, setStopRun] = useState<{ runId: string; label: string } | null>(null)
  const stopMutation = useMutation({
    mutationFn: (runId: string) => api.runs.kill(runId),
    onSuccess: () => {
      setStopRun(null)
      void qc.invalidateQueries({ queryKey: ['chief-org'] })
    },
  })

  // Derive the whole-org delegation tree from the payload (pure builder): the full
  // user → K → Chief → lead → sub-agent chain (loop-b2), so the entire org is VISIBLE.
  const tree = useMemo(() => (data ? fullOrgToDelegationTree(data) : null), [data])

  const leadOptions: LeadOption[] = useMemo(
    () => (data?.leads ?? []).map(l => ({ id: l.profile.id, name: l.profile.name })),
    [data],
  )

  async function submitHand() {
    const msg = handQuery.trim()
    if (!msg) return
    const sent = await hand.send(msg, { forceRoute: 'chief' })
    if (sent) setHandQuery('')
  }

  function onHandKeyDown(e: React.KeyboardEvent) {
    // Enter sends; skip while an IME candidate is being composed (CJK etc.).
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submitHand()
    }
  }

  /** Inspector actions per node: open a lead's control plane, jump to the backing
   *  run, and stop a live lead run (ConfirmDialog-gated — destructive). */
  function renderActions(node: DelegationNode): React.ReactNode {
    const actions: React.ReactNode[] = []
    if (node.kind === 'lead') {
      actions.push(
        <button
          key="open"
          type="button"
          data-testid="chief-open-lead"
          onClick={() => navigate('orchestrator', node.id)}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
        >
          Open lead →
        </button>,
      )
    }
    if (node.runId) {
      actions.push(
        <button
          key="view"
          type="button"
          data-testid="chief-view-run"
          onClick={() => navigate('runs', node.runId)}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
        >
          View run →
        </button>,
      )
    }
    // 'queued' is live too — the server's LIVE_RUN_STATUSES includes it, so a queued
    // lead run blocks reassign with a 409; the inspector must offer the Stop action
    // for exactly the set of states that block ('running' covers awaiting_input via
    // runStatusToDelegationStatus).
    if (node.kind === 'lead' && (node.status === 'running' || node.status === 'queued') && node.runId) {
      const runId = node.runId
      actions.push(
        <button
          key="stop"
          type="button"
          data-testid="chief-stop-run"
          onClick={() => setStopRun({ runId, label: node.label })}
          className="rounded border border-[var(--red)]/50 px-2 py-0.5 text-[11px] font-semibold text-[var(--red)] transition-colors hover:bg-red/15"
        >
          Stop run
        </button>,
      )
    }
    return actions.length > 0 ? <>{actions}</> : null
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        {/* THIN health line (payload.health) — leads active, not a full strip. */}
        {data && (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--muted)]" data-testid="chief-health">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--green)]" aria-hidden />
            <span className="text-[var(--text)]">{data.health.leadsActive}</span>
            <span>lead{data.health.leadsActive === 1 ? '' : 's'} active</span>
          </div>
        )}
      </div>

      {isLoading && <p className="text-xs italic text-[var(--muted)]">Loading org status…</p>}
      {isError && <p className="text-xs italic text-[var(--red)]">Failed to load org status.</p>}

      {data && tree && (
        <div className="space-y-6">
          {/* Hand the Chief work — a forced-route ask through the shared front door. */}
          <section data-testid="chief-hand-composer" className="glass-tint rounded-panel p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Hand Chief work
            </h2>
            <div className="mt-2 flex items-center gap-2 rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <span className="text-[var(--accent)]">⚡</span>
              <input
                value={handQuery}
                onChange={e => setHandQuery(e.target.value)}
                onKeyDown={onHandKeyDown}
                placeholder="Describe an objective for the Chief to delegate…"
                aria-label="Hand Chief work"
                className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
              />
              <button
                data-testid="chief-hand-send"
                type="button"
                onClick={() => void submitHand()}
                disabled={!handQuery.trim() || hand.busy}
                className="rounded-lg border border-accent/50 bg-accent/20 px-3 py-1.5 text-xs font-medium text-[var(--accent-hover)] transition-colors duration-100 hover:bg-accent/30 disabled:opacity-50"
              >
                Send
              </button>
            </div>
            {/* Static + honest: the route is FORCED, so no classifier preview here. */}
            <p className="mt-1.5 text-[11px] text-[var(--muted)]">will hand to Chief</p>
            {hand.error && (
              <p data-testid="chief-hand-error" className="mt-1.5 text-[11px] text-[var(--red)]">
                ⚠ {hand.error}
              </p>
            )}
          </section>

          {/* Two-column split: Objectives + whole-org delegation tree. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Objectives
              </h2>
              {data.assignments.length === 0 ? (
                <p className="text-xs italic text-[var(--muted)]" data-testid="chief-objectives-empty">
                  No objectives yet — the Chief has not assigned any leads.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.assignments.map(a => (
                    <ObjectiveRow
                      key={a.id}
                      assignment={a}
                      leads={leadOptions}
                      onReassign={(assignment, leadProfileId) => {
                        reassignMutation.reset()
                        setReassign({ assignment, leadProfileId })
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Delegation tree
              </h2>
              <DelegationTree root={tree} renderActions={renderActions} />
            </section>
          </div>

          {/* Autonomous-wake history. */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Autonomous wakes
            </h2>
            {data.chiefWakes.length === 0 ? (
              <p className="text-xs italic text-[var(--muted)]" data-testid="chief-wakes-empty">
                The Chief has not woken autonomously yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.chiefWakes.map(w => (
                  <WakeRow key={w.id} wake={w} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* Reassign confirm — names old → new; a 409 (live run / pending dispatch)
          surfaces here rather than silently failing. */}
      <ConfirmDialog
        open={reassign != null}
        title="Reassign objective?"
        message={
          reassign ? (
            <>
              Reassign &ldquo;{reassign.assignment.objective}&rdquo; from{' '}
              <span className="text-[var(--text)]">{reassign.assignment.lead}</span> to{' '}
              <span className="text-[var(--text)]">
                {leadOptions.find(l => l.id === reassign.leadProfileId)?.name ?? reassign.leadProfileId}
              </span>
              ?
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Reassign"
        testid="chief-reassign-dialog"
        busy={reassignMutation.isPending}
        error={reassignMutation.isError ? (reassignMutation.error as Error).message : undefined}
        onConfirm={() => {
          if (reassign) {
            reassignMutation.mutate({
              assignmentId: reassign.assignment.id,
              leadProfileId: reassign.leadProfileId,
            })
          }
        }}
        onCancel={() => { setReassign(null); reassignMutation.reset() }}
      />

      {/* Stop-run confirm (destructive inspector action on a live lead). */}
      <ConfirmDialog
        open={stopRun != null}
        title="Stop this lead's run?"
        message={
          stopRun ? (
            <>
              Kill <span className="text-[var(--text)]">{stopRun.label}</span>&rsquo;s live run{' '}
              <span className="mono">{stopRun.runId.slice(0, 8)}</span>? In-flight work is lost.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Stop run"
        testid="chief-stop-dialog"
        busy={stopMutation.isPending}
        error={stopMutation.isError ? (stopMutation.error as Error).message : undefined}
        onConfirm={() => { if (stopRun) stopMutation.mutate(stopRun.runId) }}
        onCancel={() => { setStopRun(null); stopMutation.reset() }}
      />

      {/* Hand-work undo toast — same shared-hook pattern as K-home (stay put,
          link to the run, 5s undo window). */}
      <Toast
        open={hand.pendingUndo !== null}
        testid="chief-hand-toast"
        durationMs={5000}
        resetKey={hand.pendingUndo?.key}
        message={
          <>
            Handed to <span className="text-[var(--text)]">Chief</span>{' '}
            <button
              type="button"
              data-testid="chief-hand-view-run"
              onClick={() => { if (hand.pendingUndo?.runId) navigate('runs', hand.pendingUndo.runId) }}
              className="text-[var(--accent-hover)] transition-colors hover:underline"
            >
              View run →
            </button>
          </>
        }
        action={{ label: 'Undo', testid: 'chief-hand-undo', onClick: () => void hand.undo() }}
        onDismiss={hand.clearUndo}
      />
    </div>
  )
}
