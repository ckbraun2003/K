import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UserMemory } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { selectThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'
import AutoTextarea from '../../components/AutoTextarea'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Button, IconButton } from '../../ui/Button'
import { SectionHeader } from '../../ui/SectionHeader'
import { EmptyState } from '../../ui/EmptyState'
import { SkeletonRow } from '../../ui/Skeleton'
import { Tag } from '../../ui/Tag'
import { Tooltip } from '../../ui/Tooltip'
import { Icon } from '../../ui/Icon'

// Mirrors HomePage.tsx's local (unexported) VIEW_KEY — the source-chat link
// hands a thread off to Home's Chat sub-view exactly like ChatsTab's Open.
const HOME_VIEW_KEY = 'k.home.view'

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

  const { data, isError, isPending } = useQuery({ queryKey: ['user-memories'], queryFn: () => api.memories.list() })
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
    // Dense list — solid surface, no blur (Task 14 ChatView-rail precedent).
    <div data-testid="memories-tab" className="surface-solid rounded-panel flex-1 overflow-y-auto p-5">
      <SectionHeader label="Memories" as="h2" count={memories.length} />

      {/* Add card — always rendered, independent of the list's load state. */}
      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-3">
        <AutoTextarea
          data-testid="memories-add-input"
          aria-label="New memory"
          placeholder="Add something for K to remember…"
          value={addText}
          onChange={e => setAddText(e.target.value)}
          onKeyDown={onAddKeyDown}
          className="w-full resize-none rounded border border-border bg-surface px-2 py-1.5 text-body text-text outline-none focus:border-accent-hover/35"
        />
        <Button
          variant="primary"
          size="sm"
          data-testid="memories-add"
          className="self-end"
          disabled={!addText.trim() || add.isPending}
          onClick={submitAdd}
        >
          Add memory
        </Button>
        {add.isError && (
          <p data-testid="memories-add-error" className="flex items-center gap-1.5 text-caption text-red">
            <Icon name="warning" size={14} className="text-red" />
            {(add.error as Error).message}
          </p>
        )}
      </div>

      {isPending ? (
        <div className="mt-3">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : isError ? (
        <p data-testid="memories-error" className="mt-3 flex items-center gap-1.5 text-caption text-red">
          <Icon name="warning" size={14} className="text-red" />
          Failed to load memories.
        </p>
      ) : memories.length === 0 ? (
        // NO hint/action here — the test asserts this element's FULL textContent
        // is exactly the headline sentence (the icon contributes no text nodes).
        <div data-testid="memories-empty">
          <EmptyState icon="docs" headline="K will remember things from your chats here — or add one yourself." />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {memories.map(m => (
            <div
              key={m.id}
              data-testid={`memories-row-${m.id}`}
              className="flex items-start gap-3 rounded-lg border border-border px-3 py-2"
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
                    className="w-full resize-none rounded border border-border bg-surface px-1.5 py-1 text-body text-text outline-none"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-body text-text">{m.content}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-caption text-muted">
                  <span className="mono">{relativeTime(m.updatedAt)}</span>
                  {m.sourceThreadId && (
                    <button
                      type="button"
                      data-testid={`memories-source-${m.id}`}
                      onClick={() => openChat(m.sourceThreadId as string)}
                      className="hover:underline"
                    >
                      <Tag tint="sky">→ from chat</Tag>
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <Tooltip content="Edit memory">
                  <IconButton
                    name="edit"
                    label="Edit memory"
                    variant="ghost"
                    data-testid={`memories-edit-${m.id}`}
                    onClick={() => startEdit(m)}
                  />
                </Tooltip>
                <Tooltip content="Delete memory">
                  <IconButton
                    name="trash"
                    label="Delete memory"
                    variant="danger"
                    data-testid={`memories-delete-${m.id}`}
                    onClick={() => setDeleting(m)}
                  />
                </Tooltip>
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
