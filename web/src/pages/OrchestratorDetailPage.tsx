import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentProfile, ChiefOrgLead, LessonStatus, RecentActuals } from '@k/shared'
import { api, type OrchestratorPatch } from '../lib/api'
import { navigate } from '../lib/route'
import { leadNode } from '../lib/delegation'
import { relativeTime } from '../lib/verify'
import { runStatusMeta } from '../lib/status'
import { cn } from '../lib/cn'
import DelegationTree from '../components/DelegationTree'
import CapabilityPicker from '../components/CapabilityPicker'
import SegControl from '../components/SegControl'
import { LessonCard } from '../components/LessonCard'
import type { MemoryLesson } from '../lib/memory'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import { Input } from '../ui/Field'

/**
 * Orchestrator detail (P5.3a) — a single discipline lead's authority editor (left,
 * tabbed) beside its live delegation tree (right). ONE batched query loads the reused
 * ChiefOrgLead detail; every edit goes through api.orchestrators.update → the
 * server-side updateProfile, which re-resolves the charter's authority and runs the
 * mcp↔allowlist grant guard fail-closed. The right panel REUSES leadNode + the shared
 * DelegationTree component (no re-derivation). Charter TEXT is tier-bound and shared
 * across orchestrator-tier leads, so per-lead charter editing is deferred (read-only).
 *
 * Task 17 (UI Simplification) additions: a `runs` tab over the detail payload's
 * `recentRuns` (measured RunStatus + cost_usd, resolved server-side — see
 * core/src/routes/org-shared.ts::assembleLead); the Memory tab gained a
 * pending|accepted|rejected SegControl (was accepted-only) with approve/reject wired
 * exactly like InboxTab's direct mutate-on-click (no confirm step); and a header
 * recent-cost line sourced from GET /api/metrics/recent-actuals — MEASURED actuals
 * only (median/p90 of stored run costs), never price×token estimation.
 */

type Tab = 'charter' | 'skills' | 'tools' | 'mcp' | 'memory' | 'runs'

const TABS: { id: Tab; label: string }[] = [
  { id: 'charter', label: 'Charter' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'memory', label: 'Memory' },
  { id: 'runs', label: 'Runs' },
]

const MEMORY_STATUS_TABS: { id: LessonStatus; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
]

function NotFound({ id }: { id?: string }) {
  return (
    <div className="h-full overflow-y-auto p-5">
      <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => navigate('agents', 'org', 'roster')}>
        Orchestrators
      </Button>
      <div className="mt-6 rounded-panel border border-border bg-surface p-6" data-testid="orchestrator-notfound">
        <EmptyState
          icon="warning"
          headline="Orchestrator not found"
          hint={id ? `No lead with id "${id}".` : 'No orchestrator selected.'}
        />
      </div>
    </div>
  )
}

export default function OrchestratorDetailPage({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('charter')
  const [toolInput, setToolInput] = useState('')
  const [memoryStatus, setMemoryStatus] = useState<LessonStatus>('pending')

  const { data: detail, isLoading, isError } = useQuery<ChiefOrgLead>({
    queryKey: ['orchestrator', id],
    queryFn: () => api.orchestrators.get(id!),
    enabled: !!id,
  })

  // This lead's lessons at the selected status (memory tab). Its own batched query,
  // deferred until the Memory tab is actually opened (a distinct data source, not used
  // by any other tab — no reason to fetch it on every detail load).
  const { data: lessons = [] } = useQuery<MemoryLesson[]>({
    queryKey: ['profile-memory', id, memoryStatus],
    queryFn: () => api.memory.lessons({ profileId: id, status: memoryStatus }),
    enabled: !!id && tab === 'memory',
  })

  // Recent measured-cost actuals for this lead's header line (E-13 lens, scoped to
  // profileId) — SUM/median/p90 of stored run costs, NEVER price×token estimation
  // (same posture as CostTodayWidget/D-087). Cheap enough to fetch alongside the
  // detail query rather than gating it behind a tab. A FAILED fetch renders an
  // explicit error indicator (CostTodayWidget's isError idiom) — silently omitting
  // it would be indistinguishable from the honest "no samples yet" state (D-026).
  const { data: recentActuals, isError: recentActualsError } = useQuery<RecentActuals>({
    queryKey: ['recent-actuals', id],
    queryFn: () => api.metrics.recentActuals({ profileId: id }),
    enabled: !!id,
  })

  // Org-default profile — the grant baseline every lead inherits. Fetched only
  // for the Tools tab (its add-suggestions datalist); skills/mcp now source
  // their candidates from the capability catalog via CapabilityPicker (C3).
  const { data: orgDefault } = useQuery<AgentProfile>({
    queryKey: ['org-default'],
    queryFn: () => api.orgDefault.get(),
    enabled: !!id && tab === 'tools',
  })

  const mutation = useMutation({
    mutationFn: (patch: OrchestratorPatch) => api.orchestrators.update(id!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orchestrator', id] })
      // The catalog's mountedBy chips must reflect the new grant immediately.
      queryClient.invalidateQueries({ queryKey: ['capabilities'] })
      setToolInput('')
    },
    // Do NOT swallow — the grant-guard 400 message is surfaced in the panel below.
  })

  // Approve/reject for the Memory tab's pending lessons — direct mutate-on-click, no
  // confirm step (InboxTab's idiom, not MemoryPage's ConfirmDialog-gated reject).
  // Invalidate the whole ['profile-memory', id] family so every status tab (this
  // lead's pending/accepted/rejected lists) reflects the move.
  const approveLesson = useMutation({
    mutationFn: (lessonId: string) => api.memory.approve(lessonId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile-memory', id] }),
  })
  const rejectLesson = useMutation({
    mutationFn: (lessonId: string) => api.memory.reject(lessonId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile-memory', id] }),
  })

  if (!id || isError) return <NotFound id={id} />
  if (isLoading || !detail) {
    return (
      <div className="flex h-full items-center gap-2 overflow-y-auto p-5 text-xs text-muted">
        <Spinner size={16} /> Loading orchestrator…
      </div>
    )
  }

  const profile = detail.profile
  const errorMsg = mutation.isError ? (mutation.error as Error).message : null

  const patch = (body: OrchestratorPatch) => mutation.mutate(body)

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => navigate('agents', 'org', 'roster')}>
          Orchestrators
        </Button>
        <h1 className="text-title text-text">{profile.name}</h1>
        <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-accent">
          {profile.tier}
        </span>
        {/* The model the NEXT dispatch will actually use — override vs runtime
            default, exactly as the server resolved it (org-shared.ts). */}
        {detail.effectiveModel && (
          <span
            data-testid="orchestrator-effective-model"
            className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted"
          >
            {detail.effectiveModel.source === 'override'
              ? `override: ${detail.effectiveModel.model}`
              : `runtime default (${detail.effectiveModel.model})`}
          </span>
        )}
        {/* Recent-run health — same real counts as the roster card (one authority). */}
        {detail.recent && detail.recent.total > 0 && (
          <span
            data-testid="orchestrator-detail-recent"
            className={cn('inline-flex items-center gap-1 text-[11px]', detail.recent.failed === 0 ? 'text-green' : 'text-amber')}
          >
            <span className="mono">{detail.recent.succeeded}/{detail.recent.total}</span> recent{' '}
            <Icon name="check" size={14} className="text-green" />
            {detail.recent.failed > 0 && <span className="mono">· {detail.recent.failed} failed</span>}
          </span>
        )}
        {/* Recent measured-cost actuals (E-13 lens) — median/p90 of ACTUAL stored run
            costs over the server's window, never a price×token estimate. Omitted
            entirely (not zeroed) when there is no sample yet (n===0) — an absent line
            reads honestly; a fabricated $0.0000 would not (D-026). A FAILED fetch is a
            third, distinct state: an explicit muted indicator, so "couldn't load" never
            masquerades as "no samples yet". */}
        {recentActualsError ? (
          <span data-testid="orch-recent-cost-error" className="text-[11px] italic text-muted">
            cost data unavailable
          </span>
        ) : recentActuals && recentActuals.n > 0 ? (
          <span data-testid="orch-recent-cost" className="mono text-[11px] text-muted">
            {`recent: median $${(recentActuals.medianCostUsd ?? 0).toFixed(4)} · p90 $${(recentActuals.p90CostUsd ?? 0).toFixed(4)} (n=${recentActuals.n}, ${recentActuals.windowDays}d)`}
          </span>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — tabbed authority editor. */}
        <section className="rounded-panel border border-border bg-surface p-4">
          <div className="mb-3">
            <SegControl<Tab>
              ariaLabel="Authority"
              options={TABS.map(t => ({ label: t.label, value: t.id }))}
              value={tab}
              onChange={setTab}
            />
          </div>

          {/* Charter — read-only (tier-bound prompt). */}
          {tab === 'charter' && (
            <div data-testid="orchestrator-panel-charter" className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Charter
                </span>
                <span className="mono rounded bg-raised px-1.5 py-0.5 text-[11px] text-text">
                  {profile.charter}
                </span>
              </div>
              <p className="text-xs text-muted">
                The charter prompt is tier-bound to{' '}
                <span className="mono text-text">
                  agent-config/tiers/{profile.charter}.charter.md
                </span>{' '}
                and shared across all orchestrator-tier leads. Editing a per-lead charter is deferred.
              </p>
            </div>
          )}

          {/* Skills — catalog-backed mount editor (C3). Values stay string[]
              qualified keys; the grant guard still answers 400 through `patch`. */}
          {tab === 'skills' && (
            <div data-testid="orchestrator-panel-skills">
              <CapabilityPicker
                kind="skills"
                profile={profile}
                onChange={skills => patch({ skills })}
                busy={mutation.isPending}
                testidPrefix="orchestrator-skill"
              />
            </div>
          )}

          {/* Tools — toggle rows (toggling off removes the grant) + add-by-name with
              org-default suggestions, so a removed grant is recoverable in place. */}
          {tab === 'tools' && (
            <div data-testid="orchestrator-panel-tools" className="space-y-2">
              <div className="space-y-1">
                {profile.allowedTools.length === 0 ? (
                  <p className="text-xs italic text-muted">No tools granted.</p>
                ) : (
                  profile.allowedTools.map(tool => (
                    <div
                      key={tool}
                      className="flex items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1.5 text-xs"
                    >
                      <span className="mono min-w-0 flex-1 truncate text-text">{tool}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={true}
                        disabled={mutation.isPending}
                        onClick={() => patch({ allowedTools: profile.allowedTools.filter(t => t !== tool) })}
                        data-testid={`orchestrator-tool-toggle-${tool}`}
                        className="flex-shrink-0 rounded-full border border-green/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green disabled:opacity-50"
                      >
                        on
                      </button>
                    </div>
                  ))
                )}
              </div>
              <form
                className="flex gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  const name = toolInput.trim()
                  if (name && !profile.allowedTools.includes(name)) {
                    patch({ allowedTools: [...profile.allowedTools, name] })
                  }
                }}
              >
                <Input
                  value={toolInput}
                  onChange={e => setToolInput(e.target.value)}
                  placeholder="add tool by name"
                  list="orchestrator-tool-suggestions"
                  data-testid="orchestrator-tool-input"
                  className="min-w-0 flex-1 px-2 py-1 text-xs"
                />
                <datalist id="orchestrator-tool-suggestions">
                  {(orgDefault?.allowedTools ?? [])
                    .filter(t => !profile.allowedTools.includes(t))
                    .map(t => <option key={t} value={t} />)}
                </datalist>
                <button
                  type="submit"
                  disabled={mutation.isPending || toolInput.trim() === ''}
                  className="flex-shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-accent-hover disabled:opacity-50"
                >
                  add
                </button>
              </form>
              <p className="text-[11px] text-muted">
                Suggestions come from the org-default profile's grants. Adds are validated
                server-side against the orchestrator tier ceiling — a tool beyond the tier
                allowlist is rejected.
              </p>
            </div>
          )}

          {/* MCP · Authority — catalog-backed mount editor (C3), trust-aware:
              untrusted/disabled servers are grayed in the add list. */}
          {tab === 'mcp' && (
            <div data-testid="orchestrator-panel-mcp" className="space-y-2">
              <CapabilityPicker
                kind="mcp"
                profile={profile}
                onChange={mcpServers => patch({ mcpServers })}
                busy={mutation.isPending}
                testidPrefix="orchestrator-mcp"
              />
              <p className="text-[11px] text-muted">
                Authority is re-resolved and grant-guarded server-side: mounting an MCP server
                requires a matching allowlist grant, or the change is rejected.
              </p>
            </div>
          )}

          {/* Memory — this lead's lessons at the selected status, with approve/reject wired
              on the pending status only (InboxTab's direct mutate idiom). A link out to the
              Inbox stays for pending lessons across every lead (no dead end); there is no
              cross-lead ALL-STATUS view post-MemoryPage retirement (Task 18). */}
          {tab === 'memory' && (
            <div data-testid="orchestrator-panel-memory" className="space-y-2">
              <SegControl<LessonStatus>
                ariaLabel="Lesson status"
                size="sm"
                options={MEMORY_STATUS_TABS.map(t => ({ label: t.label, value: t.id }))}
                value={memoryStatus}
                onChange={setMemoryStatus}
              />
              {lessons.length === 0 ? (
                <p className="text-xs italic text-muted" data-testid="orchestrator-memory-empty">
                  No {memoryStatus} lessons for this lead.
                </p>
              ) : (
                <div className="space-y-2">
                  {lessons.map(lesson => (
                    <LessonCard
                      key={lesson.id}
                      lesson={lesson}
                      onApprove={memoryStatus === 'pending' ? lid => approveLesson.mutate(lid) : undefined}
                      onReject={memoryStatus === 'pending' ? lid => rejectLesson.mutate(lid) : undefined}
                      busy={approveLesson.isPending && approveLesson.variables === lesson.id}
                    />
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted">
                This lead only — the{' '}
                <button
                  type="button"
                  data-testid="orchestrator-memory-link"
                  onClick={() => navigate('personal', 'inbox')}
                  className="text-accent-hover hover:underline"
                >
                  Inbox
                </button>{' '}
                reviews pending lessons across every profile.
              </p>
            </div>
          )}

          {/* Runs — this lead's newest resolved activations (RunStatus + measured cost_usd,
              server-joined in assembleLead). Click-through reuses the Runs page detail view. */}
          {tab === 'runs' && (
            <div data-testid="orchestrator-panel-runs" className="space-y-2">
              {(detail.recentRuns ?? []).length === 0 ? (
                <p className="text-xs italic text-muted" data-testid="orchestrator-runs-empty">
                  No recent runs for this lead.
                </p>
              ) : (
                <ul className="space-y-1">
                  {(detail.recentRuns ?? []).map(run => {
                    const meta = runStatusMeta(run.status)
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          onClick={() => navigate('runs', run.id)}
                          data-testid={`orchestrator-run-${run.id}`}
                          className="flex w-full items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1.5 text-left text-xs transition-colors hover:border-accent"
                        >
                          <span className="mono text-text">{run.id.slice(0, 8)}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                            {meta.label}
                          </span>
                          <span className="text-muted">{relativeTime(run.createdAt)}</span>
                          <span className="mono ml-auto text-text">${run.costUsd.toFixed(4)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Shared error banner — the un-swallowed server message (incl. the MCP grant guard). */}
          {errorMsg && (
            <p
              data-testid="orchestrator-error"
              className="mt-3 flex items-start gap-2 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[11px] text-red"
            >
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              <span>{errorMsg}</span>
            </p>
          )}
        </section>

        {/* Right — live delegation tree (reused component + builder). */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Live delegation
          </h2>
          <DelegationTree root={leadNode(detail)} />
        </section>
      </div>
    </div>
  )
}
