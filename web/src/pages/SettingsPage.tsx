import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Status, AgentProfile, NotificationRule, NotificationEventKey } from '@k/shared'
import { api, type OrchestratorPatch } from '../lib/api'
import { ensureNotificationPermission } from '../lib/notifications'
import {
  claudeVerdict,
  ollamaVerdict,
  githubVerdict,
  authVerdict,
  type StatusVerdict,
} from '../lib/settings-status'
import ConfirmDialog from '../components/ConfirmDialog'
import CapabilityPicker from '../components/CapabilityPicker'
import Toast from '../components/Toast'
// P5.5 — self-contained model-management sections (Claude default + local Ollama).
import { ClaudeModelSection, LocalModelsSection } from './SettingsModels'
// P5.4 — self-contained voice (push-to-talk) status section.
import { VoiceSection } from './SettingsVoice'
// Wave 2 — self-contained host-prerequisite "doctor" section.
import { SystemRequirementsSection } from './SettingsDoctor'
// P5-B — self-contained autonomous-org on/off front door section.
import { AutonomousOrgSection } from './SettingsAutonomy'
// P4 E-30 — the embedded diagnostics shell (the #/terminal redirect lands here).
import TerminalPage from './TerminalPage'
import { GlassPanel } from '../ui/GlassPanel'
import { SectionHeader } from '../ui/SectionHeader'
import { StatusPill } from '../ui/StatusPill'
import { SkeletonRow } from '../ui/Skeleton'
import { Textarea } from '../ui/Field'

// T20 — every StatusCard verdict label maps to exactly one canonical StatusPill
// status through this guard map (never an arbitrary string), picked by VISUAL
// semantics rather than literal meaning: good/confirmed postures read 'done'
// (green), broken/absent postures read 'error' (red), an explicit off-switch
// reads 'idle'; 'Loopback only' is the SAFE posture so it reads 'done' (green)
// and 'Network-exposed' is a static caution so it reads 'queued' (its meta is
// static amber, not a live pulse) — unrecognized labels fall back to 'idle'.
const VERDICT_PILL_STATUS: Record<string, string> = {
  Available: 'done',
  Authenticated: 'done',
  Reachable: 'done',
  'Not found': 'error',
  Unreachable: 'error',
  Unauthenticated: 'error',
  Disabled: 'idle',
  'Loopback only': 'done',
  'Network-exposed': 'queued',
}

function StatusCard({ title, verdict }: { title: string; verdict: StatusVerdict }) {
  return (
    <GlassPanel tier="solid" className="p-4">
      <div className="flex items-center justify-between">
        <SectionHeader label={title} as="h3" className="mb-0" />
        <StatusPill status={VERDICT_PILL_STATUS[verdict.label] ?? 'idle'} label={verdict.label} />
      </div>
      {verdict.detail && (
        <p className="mono mt-2 truncate text-caption text-muted" title={verdict.detail}>
          {verdict.detail}
        </p>
      )}
    </GlassPanel>
  )
}

function StatusSection() {
  const { data, isLoading, error } = useQuery<Status>({
    queryKey: ['status'],
    queryFn: () => api.status(),
    refetchInterval: 30_000,
  })

  if (isLoading) return <SkeletonRow />
  if (error || !data)
    return <p className="text-label text-red">Failed to load status.</p>

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <StatusCard title="Claude" verdict={claudeVerdict(data.claude)} />
      <StatusCard title="Ollama" verdict={ollamaVerdict(data.ollama)} />
      <StatusCard title="GitHub" verdict={githubVerdict(data.github)} />
      <StatusCard title="Harness Auth" verdict={authVerdict(data.auth)} />
    </div>
  )
}

export function SystemPromptSection() {
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

  // Unsaved-changes guard (F-048): the editor previously discarded an unsaved edit
  // silently on navigate/reload. While the draft is dirty, arm the browser's
  // beforeunload confirmation so a reload/close/leave can't drop the edit unnoticed.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // legacy browsers require a set returnValue to prompt
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  return (
    <GlassPanel className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <SectionHeader label="Global system prompt" as="h2" className="mb-0" />
          <p className="mt-1 text-caption text-muted">
            The base operating prompt (<span className="mono">agent-config/base-operating-prompt.md</span>) —
            applied to every agent the harness runs.
          </p>
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={!dirty || save.isPending}
          data-testid="system-prompt-save"
          className="rounded-lg border border-border bg-raised px-4 py-1.5 text-label font-semibold text-text transition-colors hover:border-accent-hover/35 disabled:opacity-40"
        >
          Save
        </button>
      </div>

      {isLoading ? (
        <SkeletonRow />
      ) : error ? (
        <p className="text-label text-red">Failed to load the system prompt.</p>
      ) : (
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={20}
          data-testid="system-prompt-editor"
          className="mono max-h-[520px] w-full overflow-y-auto text-[12px] leading-relaxed"
        />
      )}

      {save.error && (
        <p className="mt-2 text-label text-red">
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
    </GlassPanel>
  )
}

/** One removable-list + add-by-name editor for a free-text authority array — since C3
 *  used ONLY for Tools (allowlist patterns, not catalog entries); skills/mcp moved to
 *  the catalog-backed CapabilityPicker. `mono` for tool ids. */
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
      <h3 className="micro-label">{title}</h3>
      {items.length === 0 ? (
        <p className="text-label italic text-muted">None granted.</p>
      ) : (
        <ul className="space-y-1">
          {items.map(item => (
            <li
              key={item}
              className="flex items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1.5 text-label"
            >
              <span className={`${mono ? 'mono ' : ''}min-w-0 flex-1 truncate text-text`}>{item}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange(items.filter(i => i !== item))}
                data-testid={`${testidPrefix}-remove-${item}`}
                className="flex-shrink-0 text-red hover:underline disabled:opacity-50"
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
          className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-2 py-1 text-label text-text outline-none focus:border-accent-hover/35"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          className="flex-shrink-0 rounded-lg border border-border px-2.5 py-1 text-label font-semibold text-accent-hover disabled:opacity-50"
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org-default'] })
      // Catalog mountedBy chips reflect org-default mounts too (C3).
      void qc.invalidateQueries({ queryKey: ['capabilities'] })
    },
  })

  const errorMsg = mutation.isError ? (mutation.error as Error).message : null

  return (
    <GlassPanel tier="solid" className="p-4">
      <SectionHeader label="Org-default authority" as="h2" />
      <p className="mt-1 text-caption text-muted">
        The org-default orchestrator grant. Each discipline lead inherits this unless its own
        Orchestrator detail overrides it.
      </p>

      {isLoading ? (
        <SkeletonRow />
      ) : error || !data ? (
        <p className="text-caption text-red">Failed to load the org default.</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {/* Skills/MCP are catalog-backed (C3) — qualified-key mounts with
              provenance + token cost; Tools keeps the free-text AuthorityList
              (tools are allowlist patterns, not catalog entries). */}
          <CapabilityPicker
            kind="skills"
            title="Skills"
            profile={data}
            onChange={skills => mutation.mutate({ skills })}
            busy={mutation.isPending}
            testidPrefix="org-default-skills"
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
          <CapabilityPicker
            kind="mcp"
            title="MCP · Authority"
            profile={data}
            onChange={mcpServers => mutation.mutate({ mcpServers })}
            busy={mutation.isPending}
            testidPrefix="org-default-mcp"
          />
        </div>
      )}

      {errorMsg && (
        <p
          data-testid="org-default-error"
          className="mt-2 rounded-lg border border-red/40 bg-raised px-3 py-2 text-caption text-red"
        >
          {errorMsg}
        </p>
      )}
    </GlassPanel>
  )
}

// E-19 — per-event delivery rules (in-app center + optional background browser alert).
const EVENT_LABELS: Record<NotificationEventKey, string> = {
  run_awaiting_input: 'Run needs your reply',
  run_awaiting_plan: 'Plan ready for review',
  run_review_ready: 'Run ready for review',
  run_failed: 'Run failed',
  verify_fail: 'Verification failed',
  memory_saved: 'Memory saved',
}

/** Notification delivery rules (E-19). One row per event: an In-app toggle (the bell +
 *  toasts) and a Browser toggle (a background OS notification). The browser toggle first
 *  secures Notification permission from THIS user gesture — a blocked/denied prompt keeps
 *  the checkbox off and explains why, rather than silently enabling a channel that can't fire. */
function NotificationsSection() {
  const qc = useQueryClient()
  const [toast, setToast] = useState<string | null>(null)

  const { data: rules, isLoading, error } = useQuery<NotificationRule[]>({
    queryKey: ['notification-rules'],
    queryFn: () => api.notifications.rules(),
  })

  const updateRule = useMutation({
    mutationFn: ({ eventKey, patch }: { eventKey: string; patch: { inapp?: boolean; browser?: boolean } }) =>
      api.notifications.updateRule(eventKey, patch),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notification-rules'] }) },
    onError: (e: unknown) => setToast(`Couldn't update the rule: ${(e as Error).message}`),
  })

  async function toggleBrowser(rule: NotificationRule, next: boolean) {
    if (next && !(await ensureNotificationPermission())) {
      setToast('Browser notifications are blocked for this site — allow them in the browser first.')
      return
    }
    updateRule.mutate({ eventKey: rule.eventKey, patch: { browser: next } })
  }

  return (
    <GlassPanel tier="solid" className="p-4">
      <SectionHeader label="Notifications" as="h2" />
      <p className="mt-1 text-caption text-muted">
        How each event reaches you — an <span className="font-medium text-text">in-app</span> alert in
        the bell, and/or a <span className="font-medium text-text">browser</span> notification while the
        tab is backgrounded. Browser alerts need one-time permission.
      </p>

      {isLoading ? (
        <div className="mt-3">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : error || !rules ? (
        <p className="text-caption text-red">Failed to load notification rules.</p>
      ) : (
        <div className="mt-3">
          <div className="micro-label mb-1 grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-x-4">
            <span>Event</span>
            <span className="text-center">In-app</span>
            <span className="text-center">Browser</span>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {rules.map(rule => (
              <div key={rule.eventKey} className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-x-4 py-2 text-label">
                <span className="text-text">{EVENT_LABELS[rule.eventKey] ?? rule.eventKey}</span>
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    aria-label={`${EVENT_LABELS[rule.eventKey] ?? rule.eventKey} — in-app`}
                    data-testid={`notif-rule-${rule.eventKey}-inapp`}
                    checked={rule.inapp}
                    disabled={updateRule.isPending}
                    onChange={e => updateRule.mutate({ eventKey: rule.eventKey, patch: { inapp: e.target.checked } })}
                    className="h-4 w-4 accent-accent"
                  />
                </div>
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    aria-label={`${EVENT_LABELS[rule.eventKey] ?? rule.eventKey} — browser`}
                    data-testid={`notif-rule-${rule.eventKey}-browser`}
                    checked={rule.browser}
                    disabled={updateRule.isPending}
                    onChange={e => toggleBrowser(rule, e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Toast open={toast !== null} testid="notif-settings-toast" message={toast ?? ''} onDismiss={() => setToast(null)} />
    </GlassPanel>
  )
}

export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5">
        <h1 className="text-label font-semibold uppercase tracking-[0.12em] text-muted">Settings</h1>
      </div>

      <section className="mb-8">
        <StatusSection />
      </section>

      {/* Wave 2 — host prerequisite readiness (the "system doctor"). */}
      <section className="mb-8">
        <SystemRequirementsSection />
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

      {/* P5-B (E-14/E-15/E-18) — the autonomous org on/off front door. */}
      <section className="mb-8">
        <AutonomousOrgSection />
      </section>

      {/* P2 E-19 — per-event notification delivery rules. */}
      <section className="mb-8">
        <NotificationsSection />
      </section>

      <section className="mb-8">
        <SystemPromptSection />
      </section>

      {/* P4 E-30 — Diagnostics: an embedded shell (node-pty · /ws/terminal); the #/terminal redirect lands here. */}
      <section className="mb-8">
        <GlassPanel tier="solid" className="p-4">
          <SectionHeader label="Diagnostics" as="h2" />
          <p className="mt-1 text-caption text-muted">An embedded shell (node-pty · /ws/terminal) — the #/terminal redirect lands here.</p>
          <div className="mt-3 h-96 overflow-hidden rounded-xl border border-border">
            <TerminalPage />
          </div>
        </GlassPanel>
      </section>
    </div>
  )
}
