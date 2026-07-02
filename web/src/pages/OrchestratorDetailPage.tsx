import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentProfile, ChiefOrgLead } from '@k/shared'
import { api, type OrchestratorPatch } from '../lib/api'
import { navigate } from '../lib/route'
import { leadNode } from '../lib/delegation'
import DelegationTree from '../components/DelegationTree'
import type { MemoryLesson } from '../lib/memory'

/**
 * Orchestrator detail (P5.3a) — a single discipline lead's authority editor (left,
 * tabbed) beside its live delegation tree (right). ONE batched query loads the reused
 * ChiefOrgLead detail; every edit goes through api.orchestrators.update → the
 * server-side updateProfile, which re-resolves the charter's authority and runs the
 * mcp↔allowlist grant guard fail-closed. The right panel REUSES leadNode + the shared
 * DelegationTree component (no re-derivation). Charter TEXT is tier-bound and shared
 * across orchestrator-tier leads, so per-lead charter editing is deferred (read-only).
 */

type Tab = 'charter' | 'skills' | 'tools' | 'mcp' | 'memory'

const TABS: { id: Tab; label: string }[] = [
  { id: 'charter', label: 'Charter' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'memory', label: 'Memory' },
]

function NotFound({ id }: { id?: string }) {
  return (
    <div className="h-full overflow-y-auto p-5">
      <button
        type="button"
        onClick={() => navigate('orchestrators')}
        className="text-[11px] text-[var(--accent-hover)] hover:underline"
      >
        ← Orchestrators
      </button>
      <div
        className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
        data-testid="orchestrator-notfound"
      >
        <p className="text-sm font-semibold text-[var(--text)]">Orchestrator not found</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {id ? `No lead with id "${id}".` : 'No orchestrator selected.'}
        </p>
      </div>
    </div>
  )
}

export default function OrchestratorDetailPage({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('charter')
  const [skillInput, setSkillInput] = useState('')
  const [toolInput, setToolInput] = useState('')
  const [mcpInput, setMcpInput] = useState('')

  const { data: detail, isLoading, isError } = useQuery<ChiefOrgLead>({
    queryKey: ['orchestrator', id],
    queryFn: () => api.orchestrators.get(id!),
    enabled: !!id,
  })

  // Accepted lessons for this lead (memory tab). Read-only, its own batched query, and
  // deferred until the Memory tab is actually opened (it's a distinct data source, not
  // used by any other tab — no reason to fetch it on every detail load).
  const { data: lessons = [] } = useQuery<MemoryLesson[]>({
    queryKey: ['profile-memory', id],
    queryFn: () => api.memory.lessons({ profileId: id, status: 'accepted' }),
    enabled: !!id && tab === 'memory',
  })

  // Org-default profile — the grant baseline every lead inherits. Fetched only for
  // the tabs that surface its entries as add-suggestions (tools/skills datalists);
  // shared cache key with the org-default editor so react-query dedupes the read.
  const { data: orgDefault } = useQuery<AgentProfile>({
    queryKey: ['org-default'],
    queryFn: () => api.orgDefault.get(),
    enabled: !!id && (tab === 'tools' || tab === 'skills'),
  })

  const mutation = useMutation({
    mutationFn: (patch: OrchestratorPatch) => api.orchestrators.update(id!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orchestrator', id] })
      setSkillInput('')
      setToolInput('')
      setMcpInput('')
    },
    // Do NOT swallow — the grant-guard 400 message is surfaced in the panel below.
  })

  if (!id || isError) return <NotFound id={id} />
  if (isLoading || !detail) {
    return (
      <div className="h-full overflow-y-auto p-5">
        <p className="text-xs italic text-[var(--muted)]">Loading orchestrator…</p>
      </div>
    )
  }

  const profile = detail.profile
  const errorMsg = mutation.isError ? (mutation.error as Error).message : null

  const patch = (body: OrchestratorPatch) => mutation.mutate(body)

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('orchestrators')}
          className="text-[11px] text-[var(--accent-hover)] hover:underline"
        >
          ← Orchestrators
        </button>
        <h1 className="text-sm font-semibold text-[var(--text)]">{profile.name}</h1>
        <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]">
          {profile.tier}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — tabbed authority editor. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-1 text-xs">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                data-testid={`orchestrator-tab-${t.id}`}
                aria-pressed={tab === t.id}
                className={
                  tab === t.id
                    ? 'flex-1 rounded-md bg-[var(--accent)] px-2 py-1.5 text-center font-semibold text-[var(--on-accent)]'
                    : 'flex-1 rounded-md px-2 py-1.5 text-center font-semibold text-[var(--muted)] transition-colors hover:text-[var(--text)]'
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Charter — read-only (tier-bound prompt). */}
          {tab === 'charter' && (
            <div data-testid="orchestrator-panel-charter" className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                  Charter
                </span>
                <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  {profile.charter}
                </span>
              </div>
              <p className="text-xs text-[var(--muted)]">
                The charter prompt is tier-bound to{' '}
                <span className="mono text-[var(--text)]">
                  agent-config/tiers/{profile.charter}.charter.md
                </span>{' '}
                and shared across all orchestrator-tier leads. Editing a per-lead charter is deferred.
              </p>
            </div>
          )}

          {/* Skills — list + remove + add-by-name. */}
          {tab === 'skills' && (
            <div data-testid="orchestrator-panel-skills" className="space-y-2">
              {profile.skills.length === 0 ? (
                <p className="text-xs italic text-[var(--muted)]">No skills mounted.</p>
              ) : (
                <ul className="space-y-1">
                  {profile.skills.map(skill => (
                    <li
                      key={skill}
                      className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{skill}</span>
                      <button
                        type="button"
                        disabled={mutation.isPending}
                        onClick={() => patch({ skills: profile.skills.filter(s => s !== skill) })}
                        data-testid={`orchestrator-skill-remove-${skill}`}
                        className="flex-shrink-0 text-[var(--red)] hover:underline disabled:opacity-50"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="flex gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  const name = skillInput.trim()
                  if (name && !profile.skills.includes(name)) patch({ skills: [...profile.skills, name] })
                }}
              >
                <input
                  value={skillInput}
                  onChange={e => setSkillInput(e.target.value)}
                  placeholder="add skill by name"
                  list="orchestrator-skill-suggestions"
                  data-testid="orchestrator-skill-input"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
                />
                <datalist id="orchestrator-skill-suggestions">
                  {(orgDefault?.skills ?? [])
                    .filter(s => !profile.skills.includes(s))
                    .map(s => <option key={s} value={s} />)}
                </datalist>
                <button
                  type="submit"
                  disabled={mutation.isPending || skillInput.trim() === ''}
                  className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
                >
                  add
                </button>
              </form>
            </div>
          )}

          {/* Tools — toggle rows (toggling off removes the grant) + add-by-name with
              org-default suggestions, so a removed grant is recoverable in place. */}
          {tab === 'tools' && (
            <div data-testid="orchestrator-panel-tools" className="space-y-2">
              <div className="space-y-1">
                {profile.allowedTools.length === 0 ? (
                  <p className="text-xs italic text-[var(--muted)]">No tools granted.</p>
                ) : (
                  profile.allowedTools.map(tool => (
                    <div
                      key={tool}
                      className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs"
                    >
                      <span className="mono min-w-0 flex-1 truncate text-[var(--text)]">{tool}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={true}
                        disabled={mutation.isPending}
                        onClick={() => patch({ allowedTools: profile.allowedTools.filter(t => t !== tool) })}
                        data-testid={`orchestrator-tool-toggle-${tool}`}
                        className="flex-shrink-0 rounded-full border border-[var(--green)]/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--green)] disabled:opacity-50"
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
                <input
                  value={toolInput}
                  onChange={e => setToolInput(e.target.value)}
                  placeholder="add tool by name"
                  list="orchestrator-tool-suggestions"
                  data-testid="orchestrator-tool-input"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
                />
                <datalist id="orchestrator-tool-suggestions">
                  {(orgDefault?.allowedTools ?? [])
                    .filter(t => !profile.allowedTools.includes(t))
                    .map(t => <option key={t} value={t} />)}
                </datalist>
                <button
                  type="submit"
                  disabled={mutation.isPending || toolInput.trim() === ''}
                  className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
                >
                  add
                </button>
              </form>
              <p className="text-[11px] text-[var(--muted)]">
                Suggestions come from the org-default profile's grants.
              </p>
            </div>
          )}

          {/* MCP · Authority — list + remove + add (grant-guarded server-side). */}
          {tab === 'mcp' && (
            <div data-testid="orchestrator-panel-mcp" className="space-y-2">
              {profile.mcpServers.length === 0 ? (
                <p className="text-xs italic text-[var(--muted)]">No MCP servers mounted.</p>
              ) : (
                <ul className="space-y-1">
                  {profile.mcpServers.map(server => (
                    <li
                      key={server}
                      className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{server}</span>
                      <button
                        type="button"
                        disabled={mutation.isPending}
                        onClick={() => patch({ mcpServers: profile.mcpServers.filter(s => s !== server) })}
                        data-testid={`orchestrator-mcp-remove-${server}`}
                        className="flex-shrink-0 text-[var(--red)] hover:underline disabled:opacity-50"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="flex gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  const name = mcpInput.trim()
                  if (name && !profile.mcpServers.includes(name)) {
                    patch({ mcpServers: [...profile.mcpServers, name] })
                  }
                }}
              >
                <input
                  value={mcpInput}
                  onChange={e => setMcpInput(e.target.value)}
                  placeholder="add MCP server"
                  data-testid="orchestrator-mcp-input"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
                />
                <button
                  type="submit"
                  disabled={mutation.isPending || mcpInput.trim() === ''}
                  className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
                >
                  add
                </button>
              </form>
              <p className="text-[11px] text-[var(--muted)]">
                Authority is re-resolved and grant-guarded server-side: mounting an MCP server
                requires a matching allowlist grant, or the change is rejected.
              </p>
            </div>
          )}

          {/* Memory — read-only accepted lessons for this lead, with a link out to the
              Memory page where proposals are actually approved/rejected (no dead end). */}
          {tab === 'memory' && (
            <div data-testid="orchestrator-panel-memory" className="space-y-2">
              {lessons.length === 0 ? (
                <p className="text-xs italic text-[var(--muted)]" data-testid="orchestrator-memory-empty">
                  No accepted lessons for this lead.
                </p>
              ) : (
                <ul className="space-y-1">
                  {lessons.map(lesson => (
                    <li
                      key={lesson.id}
                      className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs text-[var(--text)]"
                    >
                      {lesson.lesson}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-[var(--muted)]">
                Accepted lessons only — approve or reject proposals on the{' '}
                <button
                  type="button"
                  data-testid="orchestrator-memory-link"
                  onClick={() => navigate('memory')}
                  className="text-[var(--accent-hover)] hover:underline"
                >
                  Memory page
                </button>
                .
              </p>
            </div>
          )}

          {/* Shared error banner — the un-swallowed server message (incl. the MCP grant guard). */}
          {errorMsg && (
            <p
              data-testid="orchestrator-error"
              className="mt-3 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
            >
              {errorMsg}
            </p>
          )}
        </section>

        {/* Right — live delegation tree (reused component + builder). */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Live delegation
          </h2>
          <DelegationTree root={leadNode(detail)} />
        </section>
      </div>
    </div>
  )
}
