import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChiefOrgPayload, Assignment, AgentRun } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { relativeTime } from '../lib/verify'
import { orgToDelegationTree } from '../lib/delegation'
import DelegationTree from '../components/DelegationTree'

/**
 * Chief org-status home (P5.2a) — objectives · delegation tree · autonomous-wake
 * history. ONE batched query (api.chief.org) drives the whole page: no per-item
 * useQuery fan-out. Layout mirrors the demo intent (ui-artifact.ts): a THIN health
 * line, then a two-column split (Objectives + whole-org DelegationTree), then the
 * Chief's wake history. Read-only — handing the Chief work / autonomous delegation
 * is P5.2b.
 */

/** One objective row (an Assignment). Light accents use dark-on-light for WCAG. */
function ObjectiveRow({ assignment }: { assignment: Assignment }) {
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2"
      data-testid={`chief-objective-${assignment.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
          {assignment.objective}
        </span>
        <span className="flex-shrink-0 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#241640]">
          {assignment.lead}
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
    </div>
  )
}

/** One autonomous-wake row (an AgentRun). Links into the run when it reached one. */
function WakeRow({ wake }: { wake: AgentRun }) {
  const statusClass =
    wake.status === 'completed'
      ? 'text-[var(--green)]'
      : wake.status === 'failed'
        ? 'text-[var(--red)]'
        : 'text-[var(--accent-hover)]'
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

export default function ChiefPage() {
  const { data, isLoading, isError } = useQuery<ChiefOrgPayload>({
    queryKey: ['chief-org'],
    queryFn: () => api.chief.org(),
  })

  // Derive the whole-org delegation tree from the payload (pure builder).
  const tree = useMemo(() => (data ? orgToDelegationTree(data) : null), [data])

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Chief — org overview
        </h1>
        {/* THIN health line (payload.health) — leads active, not a full strip. */}
        {data && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]" data-testid="chief-health">
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
                    <ObjectiveRow key={a.id} assignment={a} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Delegation tree
              </h2>
              <DelegationTree root={tree} />
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
    </div>
  )
}
