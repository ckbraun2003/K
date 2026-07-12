import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KThreadSummary } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { useSelectedThread, selectThread, getSelectedThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'

/** A thrown `api.threads.get` error that means the thread is DELETED (a 404) — the not-found
 *  route answers `{ error: 'not found' }`, a bare non-ok falls back to `404 <statusText>`. Lets
 *  the demotion probe tell a genuinely-gone selection (demote) from an archived-but-live one
 *  (keep) or a transient failure (keep + re-arm). Errs safe: an unrecognized error is NOT a 404,
 *  so it degrades rather than demoting. */
function is404(e: unknown): boolean {
  return e instanceof Error && /\b404\b|not found/i.test(e.message)
}

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
  const tailRef = useRef<HTMLDivElement>(null)

  const { data: threadsData, isError: threadsFailed, isSuccess: threadsLoaded } = useQuery({
    queryKey: ['k-threads'],
    queryFn: () => api.threads.list(),
  })
  const threads: KThreadSummary[] = threadsData?.threads ?? []

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
    void qc.invalidateQueries({ queryKey: ['k-threads'] }).then(async () => {
      // Re-check against the FRESH cache — and only act if this probe is still
      // the live one and the user hasn't already re-selected something else.
      if (probeRef.current !== selected || getSelectedThread() !== selected) return
      const state = qc.getQueryState<{ threads: KThreadSummary[] }>(['k-threads'])
      if (state?.status !== 'success') { probeRef.current = null; return } // failed refetch: degrade only, re-arm
      const fresh = state.data?.threads ?? []
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

  const { data: threadDetail } = useQuery({
    queryKey: ['k-thread', effectiveId],
    queryFn: () => api.threads.get(effectiveId as string),
    enabled: effectiveId !== null,
  })
  const turns = threadDetail?.turns ?? []
  // True only once the probe has proven the current selection archived-but-live — the surface
  // then shows an honest "archived" chip (a send restores it: askK un-archives on activity).
  const isArchivedSurface = effectiveId !== null && archivedSelection === effectiveId

  // Auto-scroll the latest turn into view on every new turn (send or refetch).
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' })
  }, [turns.length])

  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) => api.threads.update(vars.id, { title: vars.title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k-threads'] }),
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
      await qc.invalidateQueries({ queryKey: ['k-threads'] })
      if (getSelectedThread() !== id) return // the selection already moved on — nothing to demote
      const state = qc.getQueryState<{ threads: KThreadSummary[] }>(['k-threads'])
      if (state?.status !== 'success') return // failed refetch: degrade only, never write (spec 9)
      const fresh = state.data?.threads ?? []
      selectThread(fresh.find(t => t.id !== id)?.id ?? null) // next thread, or the empty draft
    },
  })

  function startRename(t: KThreadSummary) {
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

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {/* Thread list */}
      <div className="glass-tint rounded-panel w-64 shrink-0 overflow-y-auto">
        <button
          type="button"
          data-testid="chat-new"
          onClick={() => selectThread(null)}
          className="block w-full px-3 py-2 text-left text-xs font-medium text-[var(--accent-hover)] transition-colors duration-100 hover:bg-[var(--raised)]"
        >
          + New chat
        </button>
        {threads.map(t => {
          const isSelected = t.id === effectiveId
          return (
            <div
              key={t.id}
              data-testid={`chat-thread-row-${t.id}`}
              className={`group flex items-center gap-1 border-l-2 px-3 py-2 ${
                isSelected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-[var(--raised)]'
              }`}
            >
              {renamingId === t.id ? (
                <input
                  autoFocus
                  data-testid={`chat-rename-input-${t.id}`}
                  aria-label="Rename chat"
                  value={renameText}
                  onChange={e => setRenameText(e.target.value)}
                  onKeyDown={e => onRenameKeyDown(e, t.id)}
                  onBlur={() => setRenamingId(null)}
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-xs text-[var(--text)] outline-none"
                />
              ) : (
                <button type="button" onClick={() => selectThread(t.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-xs font-medium text-[var(--text)]">{t.title ?? 'New chat'}</div>
                  {t.snippet && <div className="truncate text-xs text-[var(--muted)]">{t.snippet}</div>}
                  {t.lastTurnAt != null && (
                    <div className="mono text-[10px] text-[var(--muted)]">{relativeTime(t.lastTurnAt)}</div>
                  )}
                </button>
              )}
              <button
                type="button"
                data-testid={`chat-rename-${t.id}`}
                aria-label="Rename"
                title="Rename"
                onClick={() => startRename(t)}
                className="shrink-0 text-[var(--muted)] opacity-0 transition-opacity duration-100 hover:text-[var(--text)] group-hover:opacity-100"
              >
                ✎
              </button>
              <button
                type="button"
                data-testid={`chat-archive-${t.id}`}
                aria-label="Archive"
                title="Archive"
                onClick={() => archive.mutate(t.id)}
                className="shrink-0 text-[var(--muted)] opacity-0 transition-opacity duration-100 hover:text-[var(--red)] group-hover:opacity-100"
              >
                ⌫
              </button>
            </div>
          )
        })}
      </div>

      {/* Transcript */}
      <div className="glass-tint rounded-panel flex-1 overflow-y-auto p-4">
        {effectiveId === null ? (
          <p data-testid="chat-empty" className="text-sm italic text-[var(--muted)]">
            Start a new conversation — the bar below sends to it.
          </p>
        ) : (
          <div className="space-y-2.5">
            {isArchivedSurface && (
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="chat-archived-indicator"
                  className="flex-shrink-0 rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--amber)]"
                >
                  archived
                </span>
                <span className="text-[10px] text-[var(--muted)]">Sending restores this chat.</span>
              </div>
            )}
            {turns.map(t => (
              <div
                key={t.id}
                data-testid={t.role === 'user' ? 'chat-turn-user' : 'chat-turn-k'}
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
                {t.runId && (
                  <button
                    type="button"
                    data-testid="chat-run-chip"
                    onClick={() => navigate('runs', t.runId!)}
                    className="text-xs text-[var(--accent-hover)] transition-colors duration-100 hover:text-[var(--text)]"
                  >
                    → view run
                  </button>
                )}
              </div>
            ))}
            <div ref={tailRef} />
          </div>
        )}
      </div>
    </div>
  )
}
