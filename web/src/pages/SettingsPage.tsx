import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Status, AgentProfile } from '@k/shared'
import { api, type OrchestratorPatch } from '../lib/api'
import {
  claudeVerdict,
  ollamaVerdict,
  githubVerdict,
  authVerdict,
  toneColor,
  type StatusVerdict,
} from '../lib/settings-status'
import AutoTextarea from '../components/AutoTextarea'
import ConfirmDialog from '../components/ConfirmDialog'
// P5.5 — self-contained model-management sections (Claude default + local Ollama).
import { ClaudeModelSection, LocalModelsSection } from './SettingsModels'
// P5.4 — self-contained voice (push-to-talk) status section.
import { VoiceSection } from './SettingsVoice'

function StatusCard({ title, verdict }: { title: string; verdict: StatusVerdict }) {
  return (
    <div className="glass rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">{title}</h3>
        <span className="flex items-center gap-1.5 text-xs text-[var(--text)]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: toneColor(verdict.tone) }}
            aria-hidden
          />
          {verdict.label}
        </span>
      </div>
      {verdict.detail && (
        <p className="mono mt-2 truncate text-[11px] text-[var(--muted)]" title={verdict.detail}>
          {verdict.detail}
        </p>
      )}
    </div>
  )
}

function StatusSection() {
  const { data, isLoading, error } = useQuery<Status>({
    queryKey: ['status'],
    queryFn: () => api.status(),
    refetchInterval: 30_000,
  })

  if (isLoading) return <p className="text-xs text-[var(--muted)]">Loading status…</p>
  if (error || !data)
    return <p className="text-xs text-[var(--red)]">Failed to load status.</p>

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <StatusCard title="Claude" verdict={claudeVerdict(data.claude)} />
      <StatusCard title="Ollama" verdict={ollamaVerdict(data.ollama)} />
      <StatusCard title="GitHub" verdict={githubVerdict(data.github)} />
      <StatusCard title="Harness Auth" verdict={authVerdict(data.auth)} />
    </div>
  )
}

function SystemPromptSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<{ md: string }>({
    queryKey: ['system-prompt'],
    queryFn: () => api.systemPrompt.get(),
  })

  const [draft, setDraft] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Seed the editor once the server md arrives (and when it changes after save).
  useEffect(() => {
    if (data?.md !== undefined) setDraft(data.md)
  }, [data?.md])

  const save = useMutation({
    mutationFn: (md: string) => api.systemPrompt.save(md),
    onSuccess: () => {
      setConfirmOpen(false)
      void qc.invalidateQueries({ queryKey: ['system-prompt'] })
    },
  })

  const dirty = data?.md !== undefined && draft !== data.md

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
            Global system prompt
          </h2>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Repo-root <span className="mono">CLAUDE.md</span> — applied to every agent the harness runs.
          </p>
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={!dirty || save.isPending}
          data-testid="system-prompt-save"
          className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-4 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-40"
        >
          Save
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-[var(--muted)]">Loading system prompt…</p>
      ) : error ? (
        <p className="text-xs text-[var(--red)]">Failed to load the system prompt.</p>
      ) : (
        <AutoTextarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          maxHeight={520}
          data-testid="system-prompt-editor"
          className="mono w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.45)]"
        />
      )}

      {save.error && (
        <p className="mt-2 text-xs text-[var(--red)]">
          {save.error instanceof Error ? save.error.message : 'Save failed.'}
        </p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Change the global system prompt?"
        message="This changes the global system prompt for EVERY agent the harness runs. The previous version is backed up automatically."
        confirmLabel="Save system prompt"
        testid="system-prompt-confirm"
        busy={save.isPending}
        error={save.error instanceof Error ? save.error.message : undefined}
        onConfirm={() => save.mutate(draft)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}

/** One removable-list + add-by-name editor for an authority array (skills / tools / mcp).
 *  Mirrors the OrchestratorDetailPage list panels. `mono` for tool/mcp ids. */
function AuthorityList({
  title,
  items,
  onChange,
  busy,
  mono,
  testidPrefix,
  addPlaceholder,
}: {
  title: string
  items: string[]
  onChange: (next: string[]) => void
  busy: boolean
  mono?: boolean
  testidPrefix: string
  addPlaceholder: string
}) {
  const [input, setInput] = useState('')
  // The value awaiting its round-trip. The input clears only once the add LANDS (the value
  // appears in the refetched list) — so a server rejection (e.g. the MCP grant guard's 400)
  // keeps the typed value instead of forcing a retype. Mirrors OrchestratorDetailPage's
  // clear-on-success (adapted: this list is stateless, so it watches `items`).
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    if (pending && items.includes(pending)) {
      setInput('')
      setPending(null)
    }
  }, [items, pending])
  return (
    <div className="space-y-2" data-testid={`${testidPrefix}-panel`}>
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs italic text-[var(--muted)]">None granted.</p>
      ) : (
        <ul className="space-y-1">
          {items.map(item => (
            <li
              key={item}
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-xs"
            >
              <span className={`${mono ? 'mono ' : ''}min-w-0 flex-1 truncate text-[var(--text)]`}>{item}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange(items.filter(i => i !== item))}
                data-testid={`${testidPrefix}-remove-${item}`}
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
          const name = input.trim()
          if (name && !items.includes(name)) {
            setPending(name)
            onChange([...items, name])
          }
        }}
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={addPlaceholder}
          data-testid={`${testidPrefix}-input`}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
        >
          add
        </button>
      </form>
    </div>
  )
}

/** Org-default authority (P5.3b) — the default-orchestrator grant each discipline lead
 *  inherits unless its own Orchestrator detail overrides it. Edits go through
 *  api.orgDefault.update, which is grant-guarded server-side (an ungranted MCP mount
 *  answers 400 — surfaced in the banner, not swallowed). */
function OrgDefaultSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<AgentProfile>({
    queryKey: ['org-default'],
    queryFn: () => api.orgDefault.get(),
  })

  const mutation = useMutation({
    mutationFn: (patch: OrchestratorPatch) => api.orgDefault.update(patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org-default'] }),
  })

  const errorMsg = mutation.isError ? (mutation.error as Error).message : null

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Org-default authority
        </h2>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          The org-default orchestrator grant. Each discipline lead inherits this unless its own
          Orchestrator detail overrides it.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-[var(--muted)]">Loading org default…</p>
      ) : error || !data ? (
        <p className="text-xs text-[var(--red)]">Failed to load the org default.</p>
      ) : (
        <div className="glass grid gap-4 rounded-xl border border-[var(--border)] p-4 sm:grid-cols-3">
          <AuthorityList
            title="Skills"
            items={data.skills}
            onChange={skills => mutation.mutate({ skills })}
            busy={mutation.isPending}
            testidPrefix="org-default-skills"
            addPlaceholder="add skill by name"
          />
          <AuthorityList
            title="Tools"
            items={data.allowedTools}
            onChange={allowedTools => mutation.mutate({ allowedTools })}
            busy={mutation.isPending}
            mono
            testidPrefix="org-default-tools"
            addPlaceholder="add tool"
          />
          <AuthorityList
            title="MCP · Authority"
            items={data.mcpServers}
            onChange={mcpServers => mutation.mutate({ mcpServers })}
            busy={mutation.isPending}
            testidPrefix="org-default-mcp"
            addPlaceholder="add MCP server"
          />
        </div>
      )}

      {errorMsg && (
        <p
          data-testid="org-default-error"
          className="mt-2 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
        >
          {errorMsg}
        </p>
      )}
    </div>
  )
}

export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5">
        <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Settings</h1>
      </div>

      <section className="mb-8">
        <StatusSection />
      </section>

      {/* P5.5 — model management (additive; P5.4's voice card can slot alongside). */}
      <section className="mb-8">
        <ClaudeModelSection />
      </section>

      <section className="mb-8">
        <LocalModelsSection />
      </section>

      <section className="mb-8">
        <VoiceSection />
      </section>

      {/* P5.3b — org-default orchestrator authority (leads inherit unless overridden). */}
      <section className="mb-8">
        <OrgDefaultSection />
      </section>

      <section>
        <SystemPromptSection />
      </section>
    </div>
  )
}
