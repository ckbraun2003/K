import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KThreadSummary } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { selectThread, getSelectedThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Button, IconButton } from '../../ui/Button'
import { SectionHeader } from '../../ui/SectionHeader'
import { EmptyState } from '../../ui/EmptyState'
import { SkeletonRow } from '../../ui/Skeleton'
import { Tag } from '../../ui/Tag'
import { Tooltip } from '../../ui/Tooltip'
import { Icon } from '../../ui/Icon'

// Mirrors HomePage.tsx's local (unexported) VIEW_KEY — Open hands a thread off
// to Home's Chat sub-view exactly the way MessageDock/ChatView itself would.
const HOME_VIEW_KEY = 'k.home.view'

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

  const { data, isError, isPending } = useQuery({
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
    // Dense list — solid surface, no blur (Task 14 ChatView-rail precedent).
    <div data-testid="chats-tab" className="surface-solid rounded-panel flex-1 overflow-y-auto p-5">
      <SectionHeader label="All chats" count={threads.length} />
      {isPending ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : isError ? (
        <p data-testid="chats-error" className="mt-3 flex items-center gap-1.5 text-caption text-red">
          <Icon name="warning" size={14} className="text-red" />
          Failed to load chats.
        </p>
      ) : threads.length === 0 ? (
        <div data-testid="chats-empty">
          <EmptyState icon="personal" headline="No chats yet" hint="Start one from Home." />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {threads.map(t => (
            <div
              key={t.id}
              data-testid={`chats-row-${t.id}`}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
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
                    className="w-full min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 text-body text-text outline-none"
                  />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-body font-medium text-text">{t.title ?? 'New chat'}</span>
                    {t.archivedAt !== null && (
                      // Tag has no rest spread — the testid rides on a wrapper span. The amber
                      // override is deliberate (no amber tint in Tag; archived keeps its warning
                      // semantics, consistent with ChatView's archived chip).
                      <span data-testid={`chats-archived-${t.id}`} className="flex-shrink-0">
                        <Tag tint="neutral" className="bg-amber/20 text-amber border-amber/25 uppercase">archived</Tag>
                      </span>
                    )}
                  </div>
                )}
                {t.snippet && <div className="truncate text-caption text-muted">{t.snippet}</div>}
                {t.lastTurnAt != null && (
                  <div className="mono text-caption text-muted">{relativeTime(t.lastTurnAt)}</div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <Button variant="ghost" size="sm" data-testid={`chats-open-${t.id}`} onClick={() => openThread(t.id)}>
                  Open
                </Button>
                <Tooltip content="Rename">
                  <IconButton
                    name="edit"
                    label="Rename"
                    variant="ghost"
                    data-testid={`chats-rename-${t.id}`}
                    onClick={() => startRename(t)}
                  />
                </Tooltip>
                {/* Text button, not an IconButton (documented deviation): the fixed ICONS set
                    has no archive glyph, and the two-state Archive/Unarchive action reads
                    clearer as text anyway. */}
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`chats-archive-${t.id}`}
                  disabled={toggleArchive.isPending}
                  onClick={() => toggleArchive.mutate(t)}
                >
                  {t.archivedAt !== null ? 'Unarchive' : 'Archive'}
                </Button>
                <Tooltip content="Delete chat">
                  <IconButton
                    name="trash"
                    label="Delete chat"
                    variant="danger"
                    data-testid={`chats-delete-${t.id}`}
                    onClick={() => openDelete(t)}
                  />
                </Tooltip>
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
            Permanently delete <span className="font-semibold text-text">{deleting?.title ?? 'this chat'}</span>?
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
