import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UserMemory } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { selectThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'
import AutoTextarea from '../../components/AutoTextarea'
import ConfirmDialog from '../../components/ConfirmDialog'

// Mirrors HomePage.tsx's local (unexported) VIEW_KEY — the source-chat link
// hands a thread off to Home's Chat sub-view exactly like ChatsTab's Open.
const HOME_VIEW_KEY = 'k.home.view'

const BTN =
  'flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-50'
const BTN_DANGER =
  'flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--red)] transition-colors hover:bg-red/15 disabled:opacity-50'
const BTN_PRIMARY =
  'self-end rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50'

/** Same handoff ChatsTab's Open performs — select the thread, remember 'chat'
 *  as Home's sub-view, and navigate there. */
function openChat(threadId: string) {
  selectThread(threadId)
  try { localStorage.setItem(HOME_VIEW_KEY, 'chat') } catch { /* storage unavailable */ }
  navigate('home')
}

/**
 * MemoriesTab (Personal hub, UI Simplification Task 15) — the operator's own
 * durable memory store (`api.memories.*` / `UserMemory`, Task 7 & 3). Distinct
 * from MemoryPage's agent-memory Lessons queue (accept/reject gated): a
 * UserMemory is saved directly, by the operator here or by K's `memory_save`
 * tool (Task 4), with no review gate.
 *
 * Add (top card), inline Edit, and confirm-gated Delete — deletion has no
 * cascade to worry about (a UserMemory is a leaf row) but still confirms,
 * matching ChatsTab's destructive-action idiom. A memory K saved from a
 * conversation carries `sourceThreadId`; its "→ from chat" link opens that
 * thread the same way ChatsTab's Open does.
 */
export default function MemoriesTab() {
  const qc = useQueryClient()
  const [addText, setAddText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [deleting, setDeleting] = useState<UserMemory | null>(null)

  const { data, isError } = useQuery({ queryKey: ['user-memories'], queryFn: () => api.memories.list() })
  const memories: UserMemory[] = data?.memories ?? []

  function invalidateMemories() {
    void qc.invalidateQueries({ queryKey: ['user-memories'] })
  }

  const add = useMutation({
    mutationFn: (content: string) => api.memories.create(content),
    onSuccess: () => {
      setAddText('') // clear ONLY on success — a failed add keeps the typed text
      invalidateMemories()
    },
  })
  const update = useMutation({
    mutationFn: (vars: { id: string; content: string }) => api.memories.update(vars.id, vars.content),
    onSuccess: invalidateMemories,
  })
  const del = useMutation({
    mutationFn: (id: string) => api.memories.remove(id),
    onSuccess: () => {
      invalidateMemories()
      setDeleting(null)
    },
    // Not swallowed — surfaced via del.error in the ConfirmDialog below; the
    // dialog stays open (`deleting` only clears on success) so a failure can
    // be retried or cancelled.
  })

  function submitAdd() {
    const content = addText.trim()
    if (content && !add.isPending) add.mutate(content)
  }
  function onAddKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submitAdd()
    }
  }

  function startEdit(m: UserMemory) {
    setEditingId(m.id)
    setEditText(m.content)
  }
  function commitEdit(id: string) {
    const content = editText.trim()
    setEditingId(null)
    if (content) update.mutate({ id, content })
  }
  function onEditKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitEdit(id)
    }
    if (e.key === 'Escape') setEditingId(null)
  }

  function closeDelete() {
    setDeleting(null)
    del.reset()
  }

  return (
    <div data-testid="memories-tab" className="glass-tint rounded-panel flex-1 overflow-y-auto p-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Memories</h2>

      {/* Add card */}
      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
        <AutoTextarea
          data-testid="memories-add-input"
          aria-label="New memory"
          placeholder="Add something for K to remember…"
          value={addText}
          onChange={e => setAddText(e.target.value)}
          onKeyDown={onAddKeyDown}
          className="w-full resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
        />
        <button
          type="button"
          data-testid="memories-add"
          disabled={!addText.trim() || add.isPending}
          onClick={submitAdd}
          className={BTN_PRIMARY}
        >
          Add memory
        </button>
        {add.isError && (
          <p data-testid="memories-add-error" className="text-[11px] text-[var(--red)]">
            {(add.error as Error).message}
          </p>
        )}
      </div>

      {isError ? (
        <p data-testid="memories-error" className="mt-3 text-xs italic text-[var(--red)]">
          Failed to load memories.
        </p>
      ) : memories.length === 0 ? (
        <p data-testid="memories-empty" className="mt-3 text-sm italic text-[var(--muted)]">
          K will remember things from your chats here — or add one yourself.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {memories.map(m => (
            <div
              key={m.id}
              data-testid={`memories-row-${m.id}`}
              className="flex items-start gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                {editingId === m.id ? (
                  <AutoTextarea
                    autoFocus
                    data-testid={`memories-edit-input-${m.id}`}
                    aria-label="Edit memory"
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => onEditKeyDown(e, m.id)}
                    onBlur={() => setEditingId(null)}
                    className="w-full resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-sm text-[var(--text)] outline-none"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-[var(--text)]">{m.content}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--muted)]">
                  <span className="mono">{relativeTime(m.updatedAt)}</span>
                  {m.sourceThreadId && (
                    <button
                      type="button"
                      data-testid={`memories-source-${m.id}`}
                      onClick={() => openChat(m.sourceThreadId as string)}
                      className="text-[var(--accent-hover)] hover:underline"
                    >
                      → from chat
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <button type="button" data-testid={`memories-edit-${m.id}`} onClick={() => startEdit(m)} className={BTN}>
                  Edit
                </button>
                <button
                  type="button"
                  data-testid={`memories-delete-${m.id}`}
                  onClick={() => setDeleting(m)}
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
        testid="memories-delete-confirm"
        title="Delete memory"
        message="Permanently delete this memory? This cannot be undone."
        confirmLabel="Delete memory"
        busy={del.isPending}
        error={del.isError ? (del.error as Error).message : undefined}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onCancel={closeDelete}
      />
    </div>
  )
}
