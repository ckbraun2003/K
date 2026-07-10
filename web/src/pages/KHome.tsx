import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChiefOrgPayload, Status, Note, KSchedule, WorkItem, KForceRoute, KThreadTurn, FeedPayload } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { useAskK } from '../lib/useAskK'
import { FORCE_ROUTE_OPTIONS } from '../lib/force-route-options'
import { FEED_KEY, feedQueryFn } from '../lib/feed-query'
import { makeFeedInvalidator } from '../lib/live-invalidate'
import { onWsMessage } from '../lib/ws'
import FeedRow from '../components/FeedRow'
import MicButton from '../components/MicButton'
import Toast from '../components/Toast'

/**
 * K-home — the front door (P5.1f → C2 parity with the ui-demo k-home). Top-to-bottom:
 * a hero (time-aware greeting · glance-to-Chief · the Ask-K composer + power controls)
 * → a 3-card glance grid (Notes · Schedule · Your work) → a recent feed (latest runs).
 * Talking to K reuses the shared `useAskK` hook so the composer and ⌘K share the same
 * front door (optimistic send + 5s Undo), with one difference: K-home does NOT
 * navigate on send (it stays put and links to the run from the undo toast), while ⌘K
 * opens the run console immediately.
 *
 * Reads (all on shared/batched cache keys, no per-item fan-out): `chief-org` (glance),
 * the shared `feed` (recent list — same key the timeline reads), `status` (mic gate), `claude-model`
 * (the model-override picker, same key as SettingsModels), `k-thread` (the durable
 * conversation — operator asks + K's replies/report-backs), and the three glance
 * reads `k-notes` / `k-schedule` / `k-work-items` (one query per card). Query
 * failures render VISIBLE error states — the front door never disguises an outage
 * as an empty org.
 */

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Short "Jul 2 · 14:00" stamp for schedule rows. */
function shortWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function KHome() {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  // Power controls: 'default' = no model override; '' = auto route (classifier).
  const [model, setModel] = useState('default')
  const [forced, setForced] = useState<'' | KForceRoute>('')
  const [newItemTitle, setNewItemTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // navigateOnSend:false — K-home stays put on send. Auto-navigating would swap the
  // Shell view, unmount this page, and kill its own Undo toast mid-window; the toast
  // offers a "View run" link instead (⌘K keeps the default navigate-on-send).
  const ask = useAskK({ navigateOnSend: false })

  const { data: org, isError: orgError } = useQuery<ChiefOrgPayload>({ queryKey: ['chief-org'], queryFn: () => api.chief.org() })
  const { data: feed } = useQuery<FeedPayload>({ queryKey: FEED_KEY, queryFn: feedQueryFn, refetchInterval: 15_000 })
  const { data: status } = useQuery<Status>({ queryKey: ['status'], queryFn: () => api.status() })
  // Same cache key as SettingsModels so react-query dedupes the model registry read.
  const { data: claudeModel } = useQuery({ queryKey: ['claude-model'], queryFn: () => api.claudeModel.get() })
  // The durable K conversation (source of truth, survives reload) — operator asks +
  // K's replies (including Chief report-backs). Live-refreshed on a run terminal via
  // the shell's run_update invalidator (F-059).
  const { data: threadData, isError: threadError } = useQuery({ queryKey: ['k-thread'], queryFn: () => api.k.thread() })
  const { data: notes = [], isError: notesError } = useQuery<Note[]>({ queryKey: ['k-notes'], queryFn: () => api.k.notes() })
  const { data: schedule, isError: scheduleError } = useQuery<KSchedule>({ queryKey: ['k-schedule'], queryFn: () => api.k.schedule() })
  const { data: workItems = [], isError: workItemsError } = useQuery<WorkItem[]>({
    queryKey: ['k-work-items'],
    queryFn: () => api.k.workItems.list('personal'),
  })

  // The landing page is where the operator always returns, so wire the live feed
  // invalidator HERE (not in ActivityStrip): run / notification / verify traffic
  // refreshes the shared ['feed'] key backing the recent list AND the timeline (E-09).
  useEffect(() => {
    const feedInv = makeFeedInvalidator(qc)
    return onWsMessage(feedInv)
  }, [qc])

  const toggleItem = useMutation({
    mutationFn: (item: WorkItem) =>
      api.k.workItems.setStatus(item.id, item.status === 'done' ? 'open' : 'done'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k-work-items'] }),
    // Not swallowed — the error renders inline under the card list below.
  })
  const addItem = useMutation({
    mutationFn: (title: string) => api.k.workItems.create(title),
    onSuccess: () => {
      // Clear the composer ONLY on success — a failed add keeps the typed title.
      setNewItemTitle('')
      void qc.invalidateQueries({ queryKey: ['k-work-items'] })
    },
  })

  const greeting = useMemo(() => greetingFor(new Date().getHours()), [])
  const trimmed = query.trim()
  // The route preview: a FORCED route previews via routeForTarget — the same shared
  // mapping the server applies — so "will hand to Chief" is honest, not a guess.
  // Both branches gate on a non-empty composer (nothing can be sent yet, so
  // previewing a route for nothing would just be noise).
  const route = useMemo(() => {
    if (!trimmed) return null
    return forced ? routeForTarget(forced) : routeForMessage(trimmed)
  }, [forced, trimmed])

  const leadsActive = org?.health.leadsActive ?? 0
  const objectives = org?.assignments.length ?? 0
  const recent = (feed?.items ?? []).slice(0, 6)
  const now = Date.now()
  const turns: KThreadTurn[] = threadData?.turns ?? []

  async function submit() {
    const msg = query.trim()
    if (!msg) return
    // Clear the composer ONLY when the send succeeds — a failed send keeps the
    // typed text (and surfaces ask.error below) so the front door never silently
    // eats a prompt.
    const sent = await ask.send(msg, {
      model: model === 'default' ? undefined : model,
      forceRoute: forced === '' ? undefined : forced,
    })
    if (sent) setQuery('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Enter sends; skip while an IME candidate is being composed (CJK etc.).
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  function onAddItemKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const title = newItemTitle.trim()
      if (title && !addItem.isPending) addItem.mutate(title)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      {/* ── Hero ── */}
      <div className="glass-tint rounded-panel p-6">
        <h2 data-testid="khome-greeting" className="text-2xl font-semibold tracking-tight text-[var(--text)]">
          {greeting}.
        </h2>
        <p data-testid="khome-glance" className="mt-1 text-sm text-[var(--muted)]">
          {orgError ? (
            // Don't render fake zeros over a failed chief-org read — say so.
            <span data-testid="khome-glance-error" className="italic text-[var(--red)]">org status unavailable</span>
          ) : (
            <>
              <span className="text-[var(--text)]">{leadsActive}</span> lead{leadsActive === 1 ? '' : 's'} active
              {' · '}
              <span className="text-[var(--text)]">{objectives}</span> objective{objectives === 1 ? '' : 's'} in flight
            </>
          )}
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

        {/* Power controls — an explicit model override + a forced route. No
            Interactive checkbox: the K ask path is already interactive by design. */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <select
            data-testid="khome-model-select"
            aria-label="Model override"
            value={model}
            onChange={e => setModel(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)]"
          >
            <option value="default">model: default</option>
            {(claudeModel?.options ?? []).map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <select
            data-testid="khome-force-route"
            aria-label="Force route"
            value={forced}
            onChange={e => setForced(e.target.value as '' | KForceRoute)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)]"
          >
            {FORCE_ROUTE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {/* Honest scope note: the override pins the run K STARTS — when the route
              escalates, that is the Chief's own run; the lead the Chief later
              dispatches resolves its model normally (profile default → runtime). */}
          <span className="text-[var(--muted)]">
            model applies to the run K starts (the Chief&apos;s own run when routing escalates)
          </span>
        </div>

        {/* Deterministic route preview. A forced route shows the FORCED label (the
            same routeForTarget mapping the server applies) — honest, not a guess;
            the classifier preview shows only while the composer is non-empty. */}
        {route && (
          <div
            data-testid="khome-route-preview"
            className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)]"
          >
            <span>{forced ? 'Forced — will hand to' : 'K routes'}</span>
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

      {/* ── Conversation with K (the durable thread — source of truth, survives
          reload) ── Rendered only once it has turns (or failed to load); a fresh
          front door stays clean with the composer alone. */}
      {(turns.length > 0 || threadError) && (
        <section data-testid="khome-thread" className="glass-tint mt-7 rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Conversation with K</h2>
          {threadError ? (
            <p data-testid="khome-thread-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load the conversation.
            </p>
          ) : (
            <div className="mt-3 space-y-2.5">
              {turns.map(t => (
                <div
                  key={t.id}
                  data-testid={`khome-thread-turn-${t.role}`}
                  className={`flex flex-col gap-0.5 ${t.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                    {t.role === 'user' ? 'You' : 'K'}
                  </span>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                      t.role === 'user'
                        ? 'bg-accent/15 text-[var(--text)]'
                        : 'border border-[var(--border)] bg-[var(--raised)] text-[var(--text)]'
                    }`}
                  >
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Glance grid: Notes · Schedule · Your work ── */}
      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Notes (read-only, light) */}
        <section data-testid="khome-notes" className="glass-tint rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Notes</h2>
          {notesError ? (
            <p data-testid="khome-notes-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load notes.
            </p>
          ) : notes.length === 0 ? (
            <p className="mt-3 text-sm italic text-[var(--muted)]">No notes yet — ask K to take one.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {notes.map(n => (
                <li
                  key={n.id}
                  className={`truncate text-sm ${n.done ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}
                >
                  {n.done && <span className="mr-1 text-[var(--green)]">✓</span>}
                  {n.body}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Schedule (read-only) */}
        <section data-testid="khome-schedule" className="glass-tint rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Schedule</h2>
          {scheduleError ? (
            <p data-testid="khome-schedule-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load schedule.
            </p>
          ) : (schedule?.events.length ?? 0) === 0 && (schedule?.reminders.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm italic text-[var(--muted)]">Nothing scheduled.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {(schedule?.events ?? []).map(ev => (
                <li key={ev.id} className="flex items-baseline gap-2 text-sm">
                  <span className="mono flex-shrink-0 text-[11px] text-[var(--muted)]">{shortWhen(ev.startsAt)}</span>
                  <span className="min-w-0 truncate text-[var(--text)]">{ev.title}</span>
                </li>
              ))}
              {(schedule?.reminders ?? []).map(r => (
                <li key={r.id} className="flex items-baseline gap-2 text-sm">
                  {/* Overdue tinted red — the most important thing on the card. */}
                  <span className={`mono flex-shrink-0 text-[11px] ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`}>
                    {shortWhen(r.remindAt)}
                  </span>
                  <span className={`min-w-0 truncate ${r.remindAt < now ? 'text-[var(--red)]' : 'text-[var(--text)]'}`}>
                    ⏰ {r.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Your work — the durable PERSONAL work-item store (kstore scope='personal'). */}
        <section data-testid="khome-workitems" className="glass-tint rounded-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Your work <span className="normal-case tracking-normal">· personal</span>
          </h2>
          {workItemsError ? (
            <p data-testid="khome-workitems-error" className="mt-3 text-xs italic text-[var(--red)]">
              Failed to load work items.
            </p>
          ) : workItems.length === 0 ? (
            <p className="mt-3 text-sm italic text-[var(--muted)]">No personal work items yet.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {workItems.map(item => (
                <div
                  key={item.id}
                  data-testid={`khome-workitem-${item.id}`}
                  className="flex items-center gap-2"
                >
                  <input
                    type="checkbox"
                    data-testid={`khome-workitem-toggle-${item.id}`}
                    aria-label={`Mark "${item.title}" ${item.status === 'done' ? 'open' : 'done'}`}
                    checked={item.status === 'done'}
                    disabled={toggleItem.isPending}
                    onChange={() => toggleItem.mutate(item)}
                    className="flex-shrink-0 accent-[var(--accent)]"
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${item.status === 'done' ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'}`}
                  >
                    {item.title}
                  </span>
                  {/* A pill only for the in-between states — open/done read from the checkbox. */}
                  {item.status !== 'open' && item.status !== 'done' && (
                    <span className="flex-shrink-0 rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--amber)]">
                      {item.status}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Inline add composer — Enter (IME-guarded) or the add button. */}
          <div className="mt-3 flex items-center gap-2">
            <input
              data-testid="khome-workitem-add-input"
              value={newItemTitle}
              onChange={e => setNewItemTitle(e.target.value)}
              onKeyDown={onAddItemKeyDown}
              placeholder="add a work item…"
              aria-label="New work item title"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
            />
            <button
              data-testid="khome-workitem-add"
              type="button"
              disabled={!newItemTitle.trim() || addItem.isPending}
              onClick={() => addItem.mutate(newItemTitle.trim())}
              className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50"
            >
              add
            </button>
          </div>
          {/* Mutation failures surface inline — never a silently-lost toggle/add. */}
          {(toggleItem.isError || addItem.isError) && (
            <p data-testid="khome-workitem-error" className="mt-2 text-[11px] text-[var(--red)]">
              ⚠ {((toggleItem.error ?? addItem.error) as Error).message}
            </p>
          )}
        </section>
      </div>

      {/* ── Recent from your org ── (the shared ['feed'] key; "See all" opens the timeline).
          The feed query swallows a dead core into EMPTY_FEED, so there is no error branch —
          an outage degrades to the empty state, never a phantom or an error row. */}
      <section data-testid="khome-recent" className="mt-7">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Recent from your org</h2>
          <button
            type="button"
            data-testid="khome-recent-seeall"
            onClick={() => navigate('timeline')}
            className="text-[11px] text-[var(--accent-hover)] transition-colors hover:text-[var(--text)]"
          >
            See all →
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="mt-3 text-sm italic text-[var(--muted)]">No recent activity.</p>
        ) : (
          <div className="mt-3 space-y-1">
            {recent.map(item => (
              <FeedRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      {/* Undo toast — mirrors ⌘K's front-door undo (shared hook), but since K-home
          does NOT auto-navigate on send (navigateOnSend:false above) the toast also
          carries the "View run" link into the run console. resetKey restarts the 5s
          window when a second send replaces the pending run. */}
      <Toast
        open={ask.pendingUndo !== null}
        testid="khome-undo-toast"
        durationMs={5000}
        resetKey={ask.pendingUndo?.key}
        message={
          <>
            Sent to K · <span className="text-[var(--text)]">{ask.pendingUndo?.route.label}</span>{' '}
            <button
              type="button"
              data-testid="khome-view-run"
              onClick={() => { if (ask.pendingUndo?.runId) navigate('runs', ask.pendingUndo.runId) }}
              className="text-[var(--accent-hover)] transition-colors hover:underline"
            >
              View run →
            </button>
          </>
        }
        action={{ label: 'Undo', testid: 'khome-undo', onClick: () => void ask.undo() }}
        onDismiss={ask.clearUndo}
      />
    </div>
  )
}
