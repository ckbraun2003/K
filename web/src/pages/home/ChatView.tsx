import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KThreadSummary } from '@k/shared'
import { api } from '../../lib/api'
import { navigate } from '../../lib/route'
import { useSelectedThread, selectThread } from '../../lib/thread-select'
import { relativeTime } from '../../lib/verify'

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
 *   - the stored selection, if the (settled) thread list still contains it —
 *     or optimistically while the list is still loading, so a valid
 *     persisted selection never flashes to empty while `['k-threads']` is
 *     in flight (its turns come from an independent `['k-thread', id]`
 *     read), else
 *   - once the list has SETTLED and the selection is confirmed missing
 *     (archived/deleted elsewhere) the newest remaining thread, or `null`
 *     if none remain.
 * The fallback is only ever WRITTEN BACK (`selectThread`) once the list read
 * has succeeded — a transient list-fetch failure degrades the render to the
 * empty state (spec 9: "chat never hard-blocks") without clobbering a real
 * persisted selection that a retry/reload could still recover.
 */
export default function ChatView() {
  const qc = useQueryClient()
  const selected = useSelectedThread()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const tailRef = useRef<HTMLDivElement>(null)

  const { data: threadsData, isPending: threadsPending, isSuccess: threadsLoaded } = useQuery({
    queryKey: ['k-threads'],
    queryFn: () => api.threads.list(),
  })
  const threads: KThreadSummary[] = threadsData?.threads ?? []

  const selectedStillValid =
    selected !== null && (threadsPending || threads.some(t => t.id === selected))
  const effectiveId: string | null =
    selected === null ? null : selectedStillValid ? selected : (threads[0]?.id ?? null)

  useEffect(() => {
    // Only commit a fallback once the list read has genuinely settled — never
    // on a still-pending or failed read (see the selection-fallback note above).
    if (threadsLoaded && effectiveId !== selected) selectThread(effectiveId)
  }, [threadsLoaded, effectiveId, selected])

  const { data: threadDetail } = useQuery({
    queryKey: ['k-thread', effectiveId],
    queryFn: () => api.threads.get(effectiveId as string),
    enabled: effectiveId !== null,
  })
  const turns = threadDetail?.turns ?? []

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['k-threads'] }),
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
