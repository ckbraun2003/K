import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationSummary } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { relativeTime } from '../lib/verify'
import { selectThread, getSelectedThread } from '../lib/thread-select'
import ConversationView from '../components/ConversationView'
import ConfirmDialog from '../components/ConfirmDialog'
import { SectionHeader } from '../ui/SectionHeader'
import { EmptyState } from '../ui/EmptyState'
import { SkeletonRow } from '../ui/Skeleton'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Field'

/**
 * MessagesPage (Continuous Agents B.6, D-123) — the unified conversations surface:
 * every conversation in one place, K's threads first, then one conversation per
 * durable agent. Unread badges ride the server's unread math; selecting a
 * conversation advances the read cursor. Personal→Chats folded in here (the
 * VIEW_REDIRECTS entry), so K-thread management (rename/archive/delete + the
 * archived toggle + >5-row search, ChatsTab parity) lives on the K rows.
 * Deep link: #/messages/<threadId>.
 */
export default function MessagesPage({ conversationId }: { conversationId?: string }) {
  const qc = useQueryClient()
  const [includeArchived, setIncludeArchived] = useState(false)
  const [q, setQ] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const { data, isPending, isError } = useQuery({
    queryKey: ['conversations', includeArchived],
    queryFn: () => api.conversations.list(includeArchived),
    refetchInterval: 10_000,
  })
  const conversations = data?.conversations ?? []
  // Search only narrows the ROW lists — the empty-state gate below stays on the
  // unfiltered length (ChatsTab's rule: zero matches ≠ the first-run empty state).
  const matches = (c: ConversationSummary) =>
    q === '' ||
    displayName(c).toLowerCase().includes(q.toLowerCase()) ||
    (c.snippet ?? '').toLowerCase().includes(q.toLowerCase())
  const kConvs = conversations.filter(c => c.profileId === 'k-secretary' && matches(c))
  const agentConvs = conversations.filter(c => c.profileId !== 'k-secretary' && matches(c))
  const selected = conversationId ? conversations.find(c => c.id === conversationId) ?? null : null

  // The last id this surface advanced the cursor for — dedups the same-selection
  // replay only. Quality review M2: the guard must NEVER suppress a re-mark when
  // NEW unread lands on the already-open conversation (the badge would stick), and
  // a failed POST must not poison the id.
  const lastMarkedId = useRef<string | null>(null)
  const markRead = useMutation({
    mutationFn: (threadId: string) => api.conversations.read(threadId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
    onError: () => { lastMarkedId.current = null },
  })
  /** Advance the read cursor NOW (row clicks — the hash→prop update can lag a
   *  render). Idempotent server-side: the cursor is clamped monotonic. */
  function markReadNow(threadId: string) {
    lastMarkedId.current = threadId
    markRead.mutate(threadId)
  }

  // Covers deep links (#/messages/<id> on mount) AND re-marks whenever new unread
  // arrives while the conversation stays selected (`unread` is a dependency).
  // Terminates: after a successful mark the refetch drives unread to 0, which
  // fails both conditions. An occasional double POST (click + effect) is harmless.
  useEffect(() => {
    if (!selected) return
    if (lastMarkedId.current !== selected.id || selected.unread > 0) markReadNow(selected.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.unread])

  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) => api.threads.update(vars.id, { title: vars.title }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] }) // Home's rail lists the same K threads
    },
  })
  const toggleArchive = useMutation({
    mutationFn: (c: ConversationSummary) => api.threads.update(c.id, { archived: c.archivedAt === null }),
    onSuccess: (_data, c) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] })
      // T11 rule (ChatsTab parity): EXPLICITLY archiving the K thread Home currently
      // has selected moves that selection to the next non-archived K conversation
      // (or the empty draft) — otherwise returning Home lands parked on the archived
      // chip state. Unarchive never touches the selection.
      if (c.archivedAt === null && c.profileId === 'k-secretary' && getSelectedThread() === c.id) {
        selectThread(
          conversations.find(x => x.profileId === 'k-secretary' && x.id !== c.id && x.archivedAt === null)?.id ?? null,
        )
      }
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.threads.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] })
      if (deleting && conversationId === deleting.id) navigate('messages')
      setDeleting(null)
      setDeleteError(undefined)
    },
    // Not swallowed — surfaced in the ConfirmDialog's error prop; the dialog stays
    // open (`deleting` only clears on success) so a live-run 409 can be retried.
    onError: (e: unknown) => setDeleteError(e instanceof Error ? e.message : String(e)),
  })

  function displayName(c: ConversationSummary): string {
    return c.title ?? c.profileName ?? c.profileId
  }

  function renderRow(c: ConversationSummary, managed: boolean) {
    const isSelected = c.id === conversationId
    return (
      <div
        key={c.id}
        className={`group flex items-center gap-1 rounded-control border-l-2 px-3 py-2 ${
          isSelected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-raised'
        }`}
      >
        {renamingId === c.id ? (
          <Input
            autoFocus
            data-testid={`messages-rename-input-${c.id}`}
            aria-label="Rename conversation"
            value={renameText}
            onChange={e => setRenameText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { setRenamingId(null); if (renameText.trim()) rename.mutate({ id: c.id, title: renameText.trim() }) }
              if (e.key === 'Escape') setRenamingId(null)
            }}
            onBlur={() => setRenamingId(null)}
            className="min-w-0 flex-1 px-1.5 py-1"
          />
        ) : (
          <button
            type="button"
            data-testid={`messages-row-${c.id}`}
            onClick={() => { markReadNow(c.id); navigate('messages', c.id) }}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-body font-medium text-text">{displayName(c)}</span>
              {c.sessionState === 'live' && (
                <span className="glow-live inline-block h-1.5 w-1.5 shrink-0 rounded-pill bg-green" aria-hidden />
              )}
              {c.archivedAt !== null && (
                <span className="rounded-pill bg-amber/20 px-1.5 text-micro uppercase text-amber">archived</span>
              )}
              {c.unread > 0 && (
                <span
                  data-testid={`messages-unread-${c.id}`}
                  className="mono ml-auto rounded-pill bg-accent/20 px-1.5 text-micro font-semibold text-accent"
                >
                  {c.unread}
                </span>
              )}
            </div>
            {c.snippet && <div className="truncate pr-1 text-caption text-muted">{c.snippet}</div>}
            {c.lastTurnAt != null && <div className="mono text-caption text-muted">{relativeTime(c.lastTurnAt)}</div>}
          </button>
        )}
        {managed && renamingId !== c.id && (
          <>
            <IconButton
              name="edit" label="Rename" variant="ghost"
              data-testid={`messages-rename-${c.id}`}
              onClick={() => { setRenamingId(c.id); setRenameText(c.title ?? '') }}
              className="shrink-0 opacity-0 group-hover:opacity-100"
            />
            <IconButton
              name={c.archivedAt !== null ? 'unarchive' : 'archive'}
              label={c.archivedAt !== null ? 'Unarchive' : 'Archive'}
              variant="ghost"
              data-testid={`messages-archive-${c.id}`}
              disabled={toggleArchive.isPending}
              onClick={() => toggleArchive.mutate(c)}
              className="shrink-0 opacity-0 group-hover:opacity-100"
            />
            <IconButton
              name="trash" label="Delete" variant="ghost"
              data-testid={`messages-delete-${c.id}`}
              onClick={() => { setDeleting(c); setDeleteError(undefined) }}
              className="shrink-0 opacity-0 hover:text-red group-hover:opacity-100"
            />
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-3 p-5">
      {/* Conversation list — K threads first, then agents */}
      <div className="glass-panel rounded-panel flex w-80 shrink-0 flex-col overflow-y-auto">
        <div className="px-2 pt-2">
          <SectionHeader
            label="Messages"
            count={isPending || isError ? undefined : conversations.length}
            as="h2"
            action={
              <Button variant="ghost" size="sm" data-testid="messages-archived-toggle" onClick={() => setIncludeArchived(a => !a)}>
                {includeArchived ? 'Hide archived' : 'Show archived'}
              </Button>
            }
          />
          {conversations.length > 5 && (
            <Input
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={q}
              onChange={e => setQ(e.target.value)}
              className="mb-2 w-full"
              data-testid="messages-search"
            />
          )}
        </div>
        <div className="flex-1 px-2 pb-2">
          {isPending ? (
            <div className="space-y-0.5">
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
            </div>
          ) : isError ? (
            // A failed list fetch must NOT masquerade as the first-run empty state
            // (spec review F1 / quality review M1 — ChatsTab had this and it was
            // dropped in the fold-in).
            <div data-testid="messages-error" className="px-1 pt-2 text-caption text-red">
              Failed to load conversations. Retrying automatically.
            </div>
          ) : conversations.length === 0 ? (
            <EmptyState icon="messages" headline="No conversations yet" hint="Message K from Home, or an agent below." />
          ) : (
            <>
              {kConvs.length > 0 && (
                <>
                  <div className="micro-label px-1 pt-1 text-muted">K</div>
                  {kConvs.map(c => renderRow(c, true))}
                </>
              )}
              {agentConvs.length > 0 && (
                <>
                  <div className="micro-label px-1 pt-2 text-muted">Agents</div>
                  {agentConvs.map(c => renderRow(c, false))}
                </>
              )}
              {kConvs.length === 0 && agentConvs.length === 0 && (
                // Reachable only via search (the groups partition a non-empty list):
                // orphaned group headers over nothing read as broken (quality minor 1).
                <div data-testid="messages-no-matches" className="px-1 pt-2 text-caption text-muted">
                  No conversations match “{q}”.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Selected conversation */}
      <div className="glass-panel rounded-panel flex min-h-0 flex-1 flex-col p-4">
        {selected == null ? (
          conversationId && !isPending && !isError ? (
            // A deep link whose id is not in the (possibly archived-filtered) list —
            // an honest not-found beats the generic hero (quality minor 2).
            <div data-testid="messages-not-found" className="flex flex-1 flex-col justify-center">
              <EmptyState
                tier="solid"
                icon="messages"
                headline="Conversation not found"
                hint="It may have been deleted — or archived: try Show archived."
              />
            </div>
          ) : (
            <EmptyState
              tier="solid"
              icon="messages"
              headline="All your conversations in one place"
              hint="K's threads and every durable agent — report-backs land here as messages from that agent."
            />
          )
        ) : (
          <ConversationView
            threadId={selected.id}
            profileId={selected.profileId}
            agentName={selected.profileName ?? selected.profileId}
            sessionState={selected.sessionState}
            contextTokens={selected.contextTokens}
          />
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        testid="messages-delete-confirm"
        title="Delete conversation"
        message={<>Permanently delete <span className="font-semibold text-text">{deleting ? displayName(deleting) : ''}</span>? Its transcript cannot be recovered.</>}
        confirmLabel="Delete"
        busy={del.isPending}
        error={deleteError}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onCancel={() => { setDeleting(null); setDeleteError(undefined); del.reset() }}
      />
    </div>
  )
}
