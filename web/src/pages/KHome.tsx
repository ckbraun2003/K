import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChiefOrgPayload, Run, Status } from '@k/shared'
import { routeForMessage } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { relativeTime } from '../lib/verify'
import { useAskK } from '../lib/useAskK'
import MicButton from '../components/MicButton'
import Toast from '../components/Toast'

/**
 * K-home — the front door (P5.1f, D-024/D-026). Top-to-bottom: a hero (time-aware
 * greeting · glance-to-Chief · the Ask-K composer) → work-in-flight (org objectives)
 * → a recent feed (latest runs). Talking to K reuses the shared `useAskK` hook so
 * the composer and ⌘K behave identically (optimistic open + 5s Undo).
 *
 * Exactly TWO org/data reads, both on shared cache keys (no fan-out): `chief-org`
 * (glance + work-items) and `runs` (recent feed); plus `status` for the mic gate.
 */

/** Run status → pill text color (shared mapping with RunList). */
function statusColor(status: string): string {
  if (status === 'done') return 'text-[var(--green)]'
  if (status === 'running') return 'text-[var(--accent-hover)]'
  if (status === 'error' || status === 'killed') return 'text-[var(--red)]'
  return 'text-[var(--muted)]'
}

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function KHome() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const ask = useAskK()

  // Shared cache keys — chief-org drives the glance + work-items (same key ChiefPage
  // uses); runs drives the recent feed (same key/fn CommandBar uses); status gates mic.
  const { data: org } = useQuery<ChiefOrgPayload>({ queryKey: ['chief-org'], queryFn: () => api.chief.org() })
  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: () => api.runs.list() })
  const { data: status } = useQuery<Status>({ queryKey: ['status'], queryFn: () => api.status() })

  const greeting = useMemo(() => greetingFor(new Date().getHours()), [])
  const trimmed = query.trim()
  const route = useMemo(() => (trimmed ? routeForMessage(trimmed) : null), [trimmed])

  const assignments = org?.assignments ?? []
  const leadsActive = org?.health.leadsActive ?? 0
  const objectives = assignments.length
  const recent = runs.slice(0, 6)

  async function submit() {
    const msg = query.trim()
    if (!msg) return
    // Clear the composer ONLY when the send succeeds — a failed send keeps the
    // typed text (and surfaces ask.error below) so the front door never silently
    // eats a prompt.
    const sent = await ask.send(msg)
    if (sent) setQuery('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Enter sends; skip while an IME candidate is being composed (CJK etc.).
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      {/* ── Hero ── */}
      <div className="glass-tint rounded-panel p-6">
        <h2 data-testid="khome-greeting" className="text-2xl font-semibold tracking-tight text-[var(--text)]">
          {greeting}, Cameron.
        </h2>
        <p data-testid="khome-glance" className="mt-1 text-sm text-[var(--muted)]">
          <span className="text-[var(--text)]">{leadsActive}</span> lead{leadsActive === 1 ? '' : 's'} active
          {' · '}
          <span className="text-[var(--text)]">{objectives}</span> objective{objectives === 1 ? '' : 's'} in flight
          {'  '}
          <button
            data-testid="khome-glance-link"
            type="button"
            onClick={() => navigate('chief')}
            className="text-[var(--accent-hover)] transition-colors duration-150 hover:text-[var(--text)]"
          >
            Chief →
          </button>
        </p>

        {/* Ask-K composer */}
        <div className="mt-4 flex items-center gap-2 rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <span className="text-[var(--accent)]">⚡</span>
          <input
            ref={inputRef}
            data-testid="khome-composer"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask K…  e.g. refactor the auth module — or hold the mic to talk"
            aria-label="Ask K"
            className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
          />
          <MicButton
            title="Hold to talk — release to transcribe into the composer"
            onTranscript={(t) => { setQuery(q => (q ? q + ' ' : '') + t); inputRef.current?.focus() }}
            disabled={!status?.voice?.enabled}
          />
          <button
            data-testid="khome-send"
            type="button"
            onClick={() => void submit()}
            disabled={!trimmed || ask.busy}
            className="rounded-lg border border-accent/50 bg-accent/20 px-3 py-1.5 text-xs font-medium text-[var(--accent-hover)] transition-colors duration-100 hover:bg-accent/30 disabled:opacity-50"
          >
            Send
          </button>
        </div>

        {/* Deterministic route preview — shown only while the composer is non-empty. */}
        {route && (
          <div
            data-testid="khome-route-preview"
            className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)]"
          >
            <span>K routes</span>
            <span className="text-[var(--text)]">→ {route.label}</span>
          </div>
        )}

        {/* A failed send surfaces here — the front door never silently eats a prompt. */}
        {ask.error && (
          <p data-testid="khome-send-error" className="mt-2 text-[11px] text-[var(--red)]">
            ⚠ {ask.error}
          </p>
        )}
      </div>

      {/* ── Work in flight ── */}
      <section data-testid="khome-workitems" className="mt-7">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Your work</h2>
        {assignments.length === 0 ? (
          <p className="mt-3 text-sm italic text-[var(--muted)]">No work items yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {assignments.map(a => (
              <div
                key={a.id}
                data-testid={`khome-workitem-${a.id}`}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{a.objective}</span>
                <span className="flex-shrink-0 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#241640]">
                  {a.lead}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-[var(--muted)]">
          These are org objectives the Chief is driving — personal-scope work items are coming soon.
        </p>
      </section>

      {/* ── Recent from your org ── */}
      <section data-testid="khome-recent" className="mt-7">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Recent from your org</h2>
        {recent.length === 0 ? (
          <p className="mt-3 text-sm italic text-[var(--muted)]">No recent activity.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {recent.map(r => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{r.prompt}</span>
                <span className={`flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide ${statusColor(r.status)}`}>
                  {r.status}
                </span>
                <span className="flex-shrink-0 text-[10px] text-[var(--muted)]">{relativeTime(r.createdAt)}</span>
                <button
                  type="button"
                  onClick={() => navigate('runs', r.id)}
                  className="flex-shrink-0 text-[var(--accent-hover)] transition-colors hover:underline"
                >
                  View run
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Undo toast — mirrors ⌘K's front-door undo (shared hook). */}
      <Toast
        open={ask.pendingUndo !== null}
        testid="khome-undo-toast"
        durationMs={5000}
        message={<>Sent to K · <span className="text-[var(--text)]">{ask.pendingUndo?.route.label}</span></>}
        action={{ label: 'Undo', testid: 'khome-undo', onClick: () => void ask.undo() }}
        onDismiss={ask.clearUndo}
      />
    </div>
  )
}
