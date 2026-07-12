import { useQuery } from '@tanstack/react-query'
import type { OrchestratorRosterPayload, OrchestratorRosterEntry } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'

/**
 * Orchestrators roster (P5.3a) — the five discipline leads as slim cards. ONE batched
 * query (api.orchestrators.list) drives the whole page: no per-lead useQuery fan-out.
 * Each card shows the lead's name, a live/idle status pill, a wakes count, and an Open
 * button into the param-routed detail view. (The charter chip was dropped — every card
 * read "ORCHESTRATOR", carrying zero signal.) Read-only here; authority edits live in
 * OrchestratorDetailPage.
 */

/** One slim roster card. Exported for render-testing (prop-fed, no queries). */
export function OrchestratorCard({ entry }: { entry: OrchestratorRosterEntry }) {
  const { profile, live, wakes, recent } = entry
  return (
    <div
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
      data-testid={`orchestrator-card-${profile.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">
          {profile.name}
        </span>
      </div>

      {/* Recent-run health — REAL counts from the lead's activation history, never
          an invented score/band. Rendered only when there is history to report. */}
      {recent && recent.total > 0 && (
        <p
          data-testid={`orchestrator-recent-${profile.id}`}
          className={`mt-1.5 text-[11px] ${recent.failed === 0 ? 'text-[var(--green)]' : 'text-[var(--amber)]'}`}
        >
          {recent.succeeded}/{recent.total} recent ✓{recent.failed > 0 && ` · ${recent.failed} failed`}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)]">
        <span
          className={
            live
              ? 'inline-flex items-center gap-1 rounded bg-[var(--raised)] px-1.5 py-0.5 font-semibold text-[var(--green)]'
              : 'inline-flex items-center gap-1 rounded bg-[var(--raised)] px-1.5 py-0.5 text-[var(--muted)]'
          }
          data-testid={`orchestrator-status-${profile.id}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-[var(--green)]' : 'bg-[var(--muted)]'}`}
            aria-hidden
          />
          {live ? 'live' : 'idle'}
        </span>
        <span>
          {wakes} wake{wakes === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => navigate('orchestrator', profile.id)}
          data-testid={`orchestrator-open-${profile.id}`}
          className="ml-auto flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)]"
        >
          Open
        </button>
      </div>
    </div>
  )
}

export default function RosterView() {
  const { data, isLoading, isError } = useQuery<OrchestratorRosterPayload>({
    queryKey: ['orchestrators'],
    queryFn: () => api.orchestrators.list(),
  })

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <button data-testid="roster-card-k" onClick={() => navigate('home')} className="glass-tint rounded-panel p-4 text-left card-lift">
          <div className="text-sm font-semibold">K</div>
          <div className="text-xs text-[var(--muted)]">Secretary — your front door. Chat lives on Home.</div>
        </button>
        <button data-testid="roster-card-chief" onClick={() => navigate('agents', 'org', 'tree')} className="glass-tint rounded-panel p-4 text-left card-lift">
          <div className="text-sm font-semibold">Chief</div>
          <div className="text-xs text-[var(--muted)]">Manager — objectives & delegation. See the Tree view.</div>
        </button>
      </div>

      <div className="mb-4 mt-4 flex items-center justify-between gap-3">
        {data && (
          <div
            className="ml-auto flex items-center gap-2 text-[11px] text-[var(--muted)]"
            data-testid="orchestrators-active"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--green)]" aria-hidden />
            <span className="text-[var(--text)]">{data.activeLeads}</span>
            <span>active</span>
          </div>
        )}
      </div>

      {isLoading && <p className="text-xs italic text-[var(--muted)]">Loading orchestrators…</p>}
      {isError && <p className="text-xs italic text-[var(--red)]">Failed to load orchestrators.</p>}

      {data && data.leads.length === 0 && (
        <p className="text-xs italic text-[var(--muted)]" data-testid="orchestrators-empty">
          No orchestrator leads seeded yet.
        </p>
      )}

      {data && data.leads.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.leads.map(entry => (
            <OrchestratorCard key={entry.profile.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
