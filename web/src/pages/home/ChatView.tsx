import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationSummary } from '@k/shared'
import { api } from '../../lib/api'
import { useSelectedThread, selectThread, getSelectedThread } from '../../lib/thread-select'
import { prefillDock } from '../../lib/dock-bus'
import { relativeTime } from '../../lib/verify'
import { useAskPending } from '../../lib/ask-pending'
import ConversationView from '../../components/ConversationView'
import { SectionHeader } from '../../ui/SectionHeader'
import { EmptyState } from '../../ui/EmptyState'
import { SkeletonRow } from '../../ui/Skeleton'
import { Button, IconButton } from '../../ui/Button'
import { Tag } from '../../ui/Tag'
import { Input } from '../../ui/Field'
import { Row } from '../../ui/Row'

/** A thrown `api.threads.get` error that means the thread is DELETED (a 404) — the not-found
 *  route answers `{ error: 'not found' }`, a bare non-ok falls back to `404 <statusText>`. Lets
 *  the demotion probe tell a genuinely-gone selection (demote) from an archived-but-live one
 *  (keep) or a transient failure (keep + re-arm). Errs safe: an unrecognized error is NOT a 404,
 *  so it degrades rather than demoting. */
function is404(e: unknown): boolean {
  return e instanceof Error && /\b404\b|not found/i.test(e.message)
}

/** K's own chat partition — the exact filter MessagesPage uses. Home's rail must never
 *  show other profiles' (orchestrator/agent) conversations. Extracted so the three
 *  read sites (main query, demotion probe, archive-demote) can't drift (A1). */
const K_PROFILE_ID = 'k-secretary'
const kThreadsOnly = (cs: ConversationSummary[] | undefined): ConversationSummary[] =>
  (cs ?? []).filter(c => c.profileId === K_PROFILE_ID)

/**
 * ChatView (UI Simplification Task 11) — Home's Chat tab: a thread-list rail
 * + the selected thread's transcript. The MessageDock bar (mounted at Shell
 * level on the `home` route, Task 10) is the composer; it shares
 * `thread-select.ts` with this view, so a send lands in the transcript live
 * via the `['k-thread']` prefix invalidation `useAskK.send` already performs.
 *
 * Selection fallback (design spec 5.1 / 9 — this task owns the rule): the
 * effective thread id is
 *   - `null` if the store holds `null` (an intentional "new chat" draft —
 *     MessageDock's `+ New chat` and this view's own `chat-new` both set it;
 *     it must NOT be silently overridden the moment threads exist), else
 *   - the stored selection, trusted optimistically while the list is loading
 *     AND while it is settled-but-possibly-stale (see the probe below) — its
 *     turns come from an independent `['k-thread', id]` read, so a valid
 *     selection never flashes to empty, else
 *   - on a FAILED list read only, the degraded render `threads[0] ?? null`
 *     (spec 9: "chat never hard-blocks") — never written back.
 *
 * A selection is only ever DEMOTED (`selectThread` written back) when the
 * list AFFIRMATIVELY invalidates it — i.e. a list fetched AFTER the selection
 * was made does not contain the id (the server's default list already
 * excludes archived threads, so archived and deleted both surface as
 * "absent"). A settled-but-STALE cached list is not evidence: MessageDock's
 * submit on a new chat runs `threads.create()` -> `selectThread(created.id)`
 * milliseconds before its ask-side `['k-threads']` invalidation lands, so the
 * just-created id is legitimately missing from the cached list for the whole
 * ask round-trip. When the selected id is absent from settled data the
 * fallback therefore PROBES: one `['k-threads']` refetch per unknown id
 * (ref-guarded, no loops), demoting to the newest remaining thread (or null)
 * only if the REFRESHED list still lacks it. A pending or failed read never
 * writes — a transient fetch failure degrades the render without clobbering
 * a persisted selection that a retry/reload could still recover.
 */
export default function ChatView() {
  const qc = useQueryClient()
  const selected = useSelectedThread()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  // The selected id, once the probe has PROVEN it archived-but-live (a by-id read succeeded
  // with archivedAt != null). Drives the honest "archived" chip on the transcript surface —
  // cleared the moment the selection returns to the list, goes null, or is demoted.
  const [archivedSelection, setArchivedSelection] = useState<string | null>(null)
  // A3: search narrows the RAIL rows only, shown once the list exceeds ~5 (MessagesPage
  // parity) — `threads` below stays the full list so selection/probe/demote logic never
  // sees a filtered view.
  const [q, setQ] = useState('')

  // A1 (ui-adjustments): the rail used to call api.threads.list() — GET /api/k/threads has no
  // profile filter, so it leaked EVERY orchestrator/agent thread into Home's chat rail.
  // api.conversations.list() returns the same KThreadSummary fields plus profileId/unread/
  // sessionState (MessagesPage's source, `['conversations']` key) — filter to K's own threads,
  // the exact partition MessagesPage.tsx already uses. The richer type is a safe superset of
  // the KThreadSummary shape this view otherwise consumes (selection/rename/archive unaffected).
  const { data: conversationsData, isError: threadsFailed, isSuccess: threadsLoaded, isPending: threadsPending } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.conversations.list(),
  })
  const threads: ConversationSummary[] = kThreadsOnly(conversationsData?.conversations)
  // Rendered rows only — never read by the selection/probe/demote logic below.
  const visibleThreads = q === '' ? threads : threads.filter(t =>
    (t.title ?? 'New chat').toLowerCase().includes(q.toLowerCase()) ||
    (t.snippet ?? '').toLowerCase().includes(q.toLowerCase()),
  )

  const selectedListed = selected !== null && threads.some(t => t.id === selected)
  const effectiveId: string | null =
    selected === null ? null
    : selectedListed ? selected
    : threadsFailed ? (threads[0]?.id ?? null) // degraded RENDER only — never written back (spec 9)
    : selected // loading, or settled-but-possibly-stale: trust the store until the probe below rules

  // §5.1 demotion probe (see the selection-fallback note above): a selection
  // absent from SETTLED list data is only demoted after ONE fresh refetch —
  // fetched after the selection was made — confirms the id is really gone
  // (archived/deleted elsewhere), never off a stale cache that may simply
  // predate a dock-created thread. `probeRef` holds the id currently being
  // probed so each unknown id triggers at most one refetch (no loops).
  const probeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!threadsLoaded || selected === null || threads.some(t => t.id === selected)) {
      probeRef.current = null // nothing unknown to probe (also re-arms after a failed read settles)
      setArchivedSelection(null) // a listed/null selection is never the archived-absent case
      return
    }
    if (probeRef.current === selected) return // probe for this id already issued
    probeRef.current = selected
    void qc.invalidateQueries({ queryKey: ['conversations'] }).then(async () => {
      // Re-check against the FRESH cache — and only act if this probe is still
      // the live one and the user hasn't already re-selected something else.
      if (probeRef.current !== selected || getSelectedThread() !== selected) return
      const state = qc.getQueryState<{ conversations: ConversationSummary[] }>(['conversations'])
      if (state?.status !== 'success') { probeRef.current = null; return } // failed refetch: degrade only, re-arm
      const fresh = kThreadsOnly(state.data?.conversations)
      if (fresh.some(t => t.id === selected)) return // the list caught up — selection was real (dock-create race)

      // Absent even from the FRESH default list: archived (the server excludes archived from the
      // default list) or deleted. A direct by-id read tells them apart — it SUCCEEDS for an archived
      // thread, 404s for a deleted one — so an archived thread opened from Chats/Memories is KEPT (its
      // transcript stays), instead of being silently demoted to a different conversation.
      try {
        const { thread: byId } = await api.threads.get(selected)
        if (probeRef.current !== selected || getSelectedThread() !== selected) return // moved on mid-fetch
        if (byId.archivedAt !== null) {
          setArchivedSelection(selected) // archived-but-live → keep it, surface the archived chip
          return
        }
        // Exists yet not archived AND absent from the default list — inconsistent; treat as gone.
        probeRef.current = null
        selectThread(fresh[0]?.id ?? null)
      } catch (e) {
        if (probeRef.current !== selected || getSelectedThread() !== selected) return
        probeRef.current = null
        if (is404(e)) selectThread(fresh[0]?.id ?? null) // confirmed deleted → newest remaining, or the empty draft
        // else: transient by-id failure → degrade only, keep the selection, re-arm (probeRef cleared)
      }
    })
  }, [threadsLoaded, selected, threads, qc])

  // True only once the probe has proven the current selection archived-but-live — the surface
  // then shows an honest "archived" chip (a send restores it: askK un-archives on activity).
  const isArchivedSurface = effectiveId !== null && archivedSelection === effectiveId
  // "K is thinking..." renders on THIS transcript only while an in-flight ask
  // targets it (ask-pending.ts) — never a fabricated status for another thread.
  // The transcript itself (turns fetch, day groups, auto-scroll) now lives in the
  // shared ConversationView (Continuous Agents B.6), which reads the SAME
  // ['k-thread', id] key this view used, so useAskK's invalidations still land.
  const pendingThread = useAskPending()
  const isPendingHere = effectiveId !== null && pendingThread === effectiveId

  // INT.2 (Lane B close carry #3): Home's transcript never advanced the read
  // cursor, so K threads accumulated PERMANENT unread badges on the Messages
  // surface. Mark the open conversation read on selection, and again when an
  // in-flight ask settles (its reply just landed in this open transcript).
  // Fire-and-forget: the cursor is a server-side monotonic clamp (idempotent);
  // a failed POST simply retries at the next transition.
  useEffect(() => {
    if (effectiveId === null || isPendingHere) return
    api.conversations.read(effectiveId).catch(() => { /* next transition retries */ })
  }, [effectiveId, isPendingHere])

  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) => api.threads.update(vars.id, { title: vars.title }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] }) // keeps MessageDock's own list in sync
    },
  })
  const archive = useMutation({
    mutationFn: (id: string) => api.threads.update(id, { archived: true }),
    // An EXPLICIT archive moves the selection OFF the thread (T11 rule) — only NAVIGATING to an
    // already-archived thread keeps it (the probe's keep+chip flow above). Demote AFTER the
    // refetch settles so `next` comes from the FRESH default list (which now excludes the
    // archived id), guarded like the probe: a selection the user already moved is never
    // clobbered. Demoting here (not leaving it to the probe) means the probe never ACTS on the
    // archived selection — its staleness guards abort any probe that raced this flow.
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] }) // keeps MessageDock's own list in sync
      if (getSelectedThread() !== id) return // the selection already moved on — nothing to demote
      const state = qc.getQueryState<{ conversations: ConversationSummary[] }>(['conversations'])
      if (state?.status !== 'success') return // failed refetch: degrade only, never write (spec 9)
      const fresh = kThreadsOnly(state.data?.conversations)
      selectThread(fresh.find(t => t.id !== id)?.id ?? null) // next thread, or the empty draft
    },
  })

  function startRename(t: ConversationSummary) {
    setRenamingId(t.id)
    setRenameText(t.title ?? '')
  }
  function commitRename(id: string) {
    const title = renameText.trim()
    setRenamingId(null)
    if (title) rename.mutate({ id, title })
  }
  function onRenameKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key === 'Enter') commitRename(id)
    if (e.key === 'Escape') setRenamingId(null)
  }

  // Exactly one "+ New chat" trigger is ever visible: the header action covers
  // loading/failed/populated, and the rail's own EmptyState (0 threads, settled)
  // supplies the CTA in that one remaining case — never both at once.
  const showHeaderNewChat = threadsPending || threadsFailed || threads.length > 0

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {/* Thread list */}
      <div data-testid="chat-thread-rail" className="glass-panel rounded-panel flex w-72 shrink-0 flex-col overflow-y-auto">
        <div className="px-2 pt-2">
          <SectionHeader
            label="Chats"
            as="h2"
            action={showHeaderNewChat ? (
              <Button
                variant="glass"
                size="sm"
                icon="plus"
                data-testid="chat-new"
                onClick={() => selectThread(null)}
              >
                New chat
              </Button>
            ) : undefined}
          />
          {/* A3: a search box only earns its keep once there's enough to search — MessagesPage's
              >5 threshold (messaging-service parity; K owns a single-profile list so no grouping
              is needed here). */}
          {threads.length > 5 && (
            <Input
              aria-label="Search chats"
              placeholder="Search chats…"
              value={q}
              onChange={e => setQ(e.target.value)}
              className="mb-2 w-full"
              data-testid="chat-search"
            />
          )}
        </div>
        <div className="flex-1 px-2 pb-2">
          {threadsPending ? (
            <div className="space-y-0.5">
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
            </div>
          ) : threadsLoaded && threads.length === 0 ? (
            <EmptyState
              icon="personal"
              headline="No chats yet"
              action={<Button icon="plus" onClick={() => selectThread(null)}>New chat</Button>}
            />
          ) : threadsLoaded && visibleThreads.length === 0 ? (
            // Reachable only via search — a real (non-empty) list with zero matches must not
            // masquerade as the first-run empty state (ChatsTab/MessagesPage parity).
            <div data-testid="chat-no-matches" className="px-1 pt-2 text-caption text-muted">
              No chats match “{q}”.
            </div>
          ) : (
            visibleThreads.map(t => {
              const isSelected = t.id === effectiveId
              if (renamingId === t.id) {
                return (
                  <div
                    key={t.id}
                    data-testid={`chat-thread-row-${t.id}`}
                    className="flex items-center gap-2 border-b border-border bg-[var(--glass-panel-bg)] px-4 py-2.5"
                  >
                    <Input
                      autoFocus
                      data-testid={`chat-rename-input-${t.id}`}
                      aria-label="Rename chat"
                      value={renameText}
                      onChange={e => setRenameText(e.target.value)}
                      onKeyDown={e => onRenameKeyDown(e, t.id)}
                      onBlur={() => setRenamingId(null)}
                      className="min-w-0 flex-1 px-1.5 py-1"
                    />
                  </div>
                )
              }
              return (
                <Row
                  key={t.id}
                  testid={`chat-thread-row-${t.id}`}
                  selected={isSelected}
                  onClick={() => selectThread(t.id)}
                  title={t.title ?? 'New chat'}
                  sub={t.snippet}
                  meta={
                    <span className="flex items-center gap-1.5">
                      {t.unread > 0 && (
                        <span
                          data-testid={`chat-unread-${t.id}`}
                          className="rounded-pill bg-accent/20 px-1.5 text-micro font-semibold text-accent"
                        >
                          {t.unread}
                        </span>
                      )}
                      {t.lastTurnAt != null && <span>{relativeTime(t.lastTurnAt)}</span>}
                    </span>
                  }
                  actions={
                    <>
                      <IconButton
                        name="edit"
                        label="Rename"
                        variant="ghost"
                        data-testid={`chat-rename-${t.id}`}
                        onClick={e => { e.stopPropagation(); startRename(t) }}
                      />
                      <IconButton
                        name="trash"
                        label="Archive"
                        variant="ghost"
                        data-testid={`chat-archive-${t.id}`}
                        onClick={e => { e.stopPropagation(); archive.mutate(t.id) }}
                        className="hover:text-red"
                      />
                    </>
                  }
                />
              )
            })
          )}
        </div>
      </div>

      {/* Transcript */}
      {/* No overflow here — the embedded ConversationView owns transcript scrolling
          (a second scroll container would nest scrollbars; quality minor 7). */}
      <div data-testid="chat-transcript" className="glass-panel rounded-panel flex min-h-0 flex-1 flex-col p-4">
        {effectiveId === null ? (
          <div data-testid="chat-empty" className="flex h-full flex-col items-center justify-center gap-4">
            <EmptyState
              tier="solid"
              icon="bolt"
              headline="Meet K — your org's front door"
              hint="Ask anything. K answers logistics itself and hands engineering work to the Chief and the leads. @project dispatches an agent run."
            />
            <div className="flex flex-wrap justify-center gap-2">
              {[
                'What needs my attention today?',
                'Summarize the last runs across my projects',
                '@',
              ].map(p => (
                <button
                  key={p}
                  type="button"
                  data-testid="chat-suggest"
                  onClick={() => prefillDock(p)}
                  className="rounded-pill border border-[var(--glass-tier-border)] bg-[var(--glass-3)] px-3 py-1.5 text-caption text-muted transition-colors duration-[var(--dur-1)] hover:border-strong hover:text-text"
                >
                  {p === '@' ? '@project — dispatch a run' : p}
                </button>
              ))}
            </div>
            {threads.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {threads.slice(0, 3).map(t => (
                  <button key={t.id} type="button" data-testid="chat-recent-chip" onClick={() => selectThread(t.id)}>
                    <Tag tint="neutral">{t.title ?? 'New chat'}</Tag>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5">
            {isArchivedSurface && (
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="chat-archived-indicator"
                  className="flex-shrink-0 rounded-pill bg-amber/20 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-amber"
                >
                  archived
                </span>
                <span className="text-micro text-muted">Sending restores this chat.</span>
              </div>
            )}
            {/* Shared transcript (Continuous Agents B.6) — composer OFF: the
                MessageDock bar owns Home's composer (Task 10). */}
            <ConversationView threadId={effectiveId} profileId="k-secretary" agentName="K" showComposer={false} />
            {isPendingHere && (
              <div data-testid="chat-typing" className="flex items-center gap-1.5 text-caption text-muted">
                <span className="glow-live inline-block h-1.5 w-1.5 rounded-pill bg-accent" aria-hidden />
                K is thinking…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
