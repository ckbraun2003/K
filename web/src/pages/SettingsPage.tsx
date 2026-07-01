import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Status } from '@k/shared'
import { api } from '../lib/api'
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

      <section>
        <SystemPromptSection />
      </section>
    </div>
  )
}
