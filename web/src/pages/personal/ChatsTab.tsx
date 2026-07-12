import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KThreadSummary } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { selectThread, getSelectedThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'
import ConfirmDialog from '../../components/ConfirmDialog'

// Mirrors HomePage.tsx's local (unexported) VIEW_KEY — Open hands a thread off
// to Home's Chat sub-view exactly the way MessageDock/ChatView itself would.
const HOME_VIEW_KEY = 'k.home.view'

const BTN =
  'flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50'
const BTN_DANGER =
  'flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--red)] transition-colors hover:bg-red/15 disabled:opacity-50'

/**
 * ChatsTab (Personal hub, UI Simplification Task 15) — the full thread
 * MANAGEMENT surface. Unlike Home's ChatView (Task 11, day-to-day chat,
 * non-archived only), this lists EVERY thread including archived ones
 * (`api.threads.list(true)`) so an operator can find, rename, archive/
 * unarchive, or permanently delete any chat.
 *
 * Delete is confirm-gated (ConfirmDialog): deletion cascades server-side
 * (`k_thread_turns` FK, Task 2) and can't be undone, and a thread with a
 * still-live run 409s — that rejection surfaces INLINE in the dialog (its
 * `error` prop) rather than silently closing it, so the operator can retry
 * or cancel with full information.
 *
 * Open hands off to Home's Chat view: select the thread in the shared
 * `thread-select.ts` store, flip the remembered Home sub-view to 'chat', and
 * navigate there. An EXPLICIT archive of the currently-selected thread also
 * moves the selection off it here (T11 rule, mirrors ChatView's archive) —
 * otherwise returning Home would land parked on the archived chip state.
 * Delete still leaves demotion to ChatView's selection-fallback probe (Task
 * 11): its by-id read 404s a deleted id and demotes.
 */
export default function ChatsTab() {
  const qc = useQueryClient()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [deleting, setDeleting] = useState<KThreadSummary | null>(null)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const { data, isError } = useQuery({
    queryKey: ['k-threads', 'all'],
    queryFn: () => api.threads.list(true),
  })
  const threads: KThreadSummary[] = data?.threads ?? []

  function invalidateThreads() {
    void qc.invalidateQueries({ queryKey: ['k-threads'] })
  }

  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) => api.threads.update(vars.id, { title: vars.title }),
    onSuccess: invalidateThreads,
  })
  const toggleArchive = useMutation({
    mutationFn: (t: KThreadSummary) => api.threads.update(t.id, { archived: t.archivedAt === null }),
    onSuccess: (_data, t) => {
      invalidateThreads()
      // T11 rule (mirrors ChatView's archive): an EXPLICIT archive of the currently-selected
      // thread moves the selection off it — next = the first OTHER non-archived thread in this
      // tab's own (include-archived) list, or the empty draft. UNARCHIVE never touches the
      // selection, and the getSelectedThread() guard never clobbers one that already moved.
      if (t.archivedAt === null && getSelectedThread() === t.id) {
        selectThread(threads.find(x => x.id !== t.id && x.archivedAt === null)?.id ?? null)
      }
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.threads.remove(id),
    onSuccess: () => {
      invalidateThreads()
      setDeleting(null)
      setDeleteError(undefined)
    },
    // Not swallowed — surfaced in the ConfirmDialog's error prop; the dialog
    // stays open (`deleting` is only cleared on success) so a live-run 409
    // can be retried once the run finishes, or cancelled.
    onError: (e: unknown) => setDeleteError(e instanceof Error ? e.message : String(e)),
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

  function openThread(id: string) {
    selectThread(id)
    try { localStorage.setItem(HOME_VIEW_KEY, 'chat') } catch { /* storage unavailable */ }
    navigate('home')
  }

  function openDelete(t: KThreadSummary) {
    setDeleting(t)
    setDeleteError(undefined)
  }
  function closeDelete() {
    setDeleting(null)
    setDeleteError(undefined)
    del.reset()
  }

  return (
    <div data-testid="chats-tab" className="glass-tint rounded-panel flex-1 overflow-y-auto p-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
        All chats · {threads.length}
      </h2>
      {isError ? (
        <p data-testid="chats-error" className="mt-3 text-xs italic text-[var(--red)]">
          Failed to load chats.
        </p>
      ) : threads.length === 0 ? (
        <p data-testid="chats-empty" className="mt-3 text-sm italic text-[var(--muted)]">
          No chats yet — start one from Home.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {threads.map(t => (
            <div
              key={t.id}
              data-testid={`chats-row-${t.id}`}
              className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                {renamingId === t.id ? (
                  <input
                    autoFocus
                    data-testid={`chats-rename-input-${t.id}`}
                    aria-label="Rename chat"
                    value={renameText}
                    onChange={e => setRenameText(e.target.value)}
                    onKeyDown={e => onRenameKeyDown(e, t.id)}
                    onBlur={() => setRenamingId(null)}
                    className="w-full min-w-0 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
                  />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-[var(--text)]">{t.title ?? 'New chat'}</span>
                    {t.archivedAt !== null && (
                      <span
                        data-testid={`chats-archived-${t.id}`}
                        className="flex-shrink-0 rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--amber)]"
                      >
                        archived
                      </span>
                    )}
                  </div>
                )}
                {t.snippet && <div className="truncate text-xs text-[var(--muted)]">{t.snippet}</div>}
                {t.lastTurnAt != null && (
                  <div className="mono text-[10px] text-[var(--muted)]">{relativeTime(t.lastTurnAt)}</div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <button type="button" data-testid={`chats-open-${t.id}`} onClick={() => openThread(t.id)} className={BTN}>
                  Open
                </button>
                <button
                  type="button"
                  data-testid={`chats-rename-${t.id}`}
                  aria-label="Rename"
                  onClick={() => startRename(t)}
                  className={BTN}
                >
                  ✎
                </button>
                <button
                  type="button"
                  data-testid={`chats-archive-${t.id}`}
                  disabled={toggleArchive.isPending}
                  onClick={() => toggleArchive.mutate(t)}
                  className={BTN}
                >
                  {t.archivedAt !== null ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  type="button"
                  data-testid={`chats-delete-${t.id}`}
                  onClick={() => openDelete(t)}
                  className={BTN_DANGER}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        testid="chats-delete-confirm"
        title="Delete chat"
        message={
          <>
            Permanently delete <span className="font-semibold text-[var(--text)]">{deleting?.title ?? 'this chat'}</span>?
            Its entire transcript is removed and cannot be recovered.
          </>
        }
        confirmLabel="Delete chat"
        busy={del.isPending}
        error={deleteError}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onCancel={closeDelete}
      />
    </div>
  )
}
