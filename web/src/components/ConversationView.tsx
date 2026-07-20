import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { groupFeedByDay } from '../lib/feed-query'
import { Button } from '../ui/Button'
import { Input } from '../ui/Field'
import { Tag } from '../ui/Tag'

/** The relay's real provenance block (`[message from <sender> · <priority>] …`) plus
 *  the W0 interim `[from <profileId>] …` tag. One regex, exported for tests — the UI's
 *  parse contract with message-relay.ts::provenanceBlock. The `·`-exclusion in the
 *  sender charset is LOAD-BEARING: it makes the priority group the only way a `·`
 *  appears, so an unknown priority word fails the whole parse and the raw tag stays
 *  visible (never misattributed). splitProvenanceSegments' lookahead carries the
 *  SAME charset + suffix (INT.2 unification) so no string splits as a boundary yet
 *  renders as plain text. */
const PROVENANCE_RE = /^\[(?:message )?from ([^\]·\n]+?)(?:\s·\s(normal|urgent))?\]\s?/

/** Undo message-relay.ts::escapeProvenanceLookalikes for DISPLAY (INT.2): the relay
 *  backslash-escapes line-leading tag lookalikes inside message bodies so they can't
 *  forge segment senders; the transcript shows the author's original text. */
export function unescapeProvenanceLookalikes(text: string): string {
  return text.replace(/(^|\n)\\(\[(?:message )?from )/g, '$1$2')
}

export function parseProvenance(text: string): {
  sender: string | null
  priority: 'normal' | 'urgent' | null
  rest: string
} {
  const m = PROVENANCE_RE.exec(text)
  if (!m) return { sender: null, priority: null, rest: text }
  return {
    sender: m[1].trim(),
    priority: (m[2] as 'normal' | 'urgent' | undefined) ?? null,
    rest: text.slice(m[0].length),
  }
}

/** The relay delivers a claimed BATCH as one turn — provenanceBlock strings joined
 *  with '\n\n' (message-relay.ts). Rendering that whole turn under its FIRST tag
 *  would misattribute every later message (quality review M5), so split the turn
 *  into per-message segments at embedded tag boundaries. Single-message and plain
 *  turns come back as one segment. NOTE: a body that itself CONTAINS
 *  '\n\n[message from …]' can forge a segment boundary — relay-side escaping is
 *  the real fix (flagged for INT.2); this split is still strictly more honest
 *  than first-tag-wins. */
export function splitProvenanceSegments(text: string): string[] {
  // Charset + priority-suffix UNIFIED with PROVENANCE_RE (INT.2): a boundary is
  // only a tag the parser would actually accept — an unknown-priority lookalike
  // neither splits nor parses.
  return text.split(/\n\n(?=\[(?:message )?from [^\]·\n]+?(?:\s·\s(?:normal|urgent))?\])/)
}

/**
 * ConversationView (Continuous Agents B.6) — the shared transcript + composer for
 * ANY conversation: Home's K chat (composer off — the MessageDock owns it there),
 * the Messages page, and agent detail pages. Turns come from the generic
 * GET /api/k/threads/:id read; sends route by owner: K threads → /api/k/ask
 * (interactive path), agent conversations → the mailbox
 * (POST /api/agents/:profileId/message). Inbound mailbox messages arrive as
 * provenance-tagged `user` turns — parseProvenance renders them as messages FROM
 * their sender (report-backs read as messages from that agent).
 */
export default function ConversationView({
  threadId, profileId, agentName, sessionState, contextTokens, showComposer = true,
}: {
  threadId: string
  profileId: string
  agentName: string
  sessionState?: 'live' | 'resumable' | 'stale' | null
  contextTokens?: number | null
  showComposer?: boolean
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const tailRef = useRef<HTMLDivElement>(null)
  const isK = profileId === 'k-secretary'

  // Same key ChatView's transcript used (['k-thread', id]) — matched by useAskK.send's
  // `['k-thread']` PREFIX invalidation, so a dock-sent ask refreshes this view live.
  // Agent conversations poll: mailbox delivery lands ASYNCHRONOUSLY (relay wake, or
  // held while a run is live) — without this the delivered turn never appears until
  // a refocus (quality review M4). K threads stay event-driven (useAskK + live-invalidate).
  const { data } = useQuery({
    queryKey: ['k-thread', threadId],
    queryFn: () => api.threads.get(threadId),
    refetchInterval: isK ? false : 10_000,
  })
  const turns = data?.turns ?? []
  const dayGroups = groupFeedByDay(turns.map(t => ({ ...t, ts: t.createdAt })))

  useEffect(() => {
    // Optional-call: jsdom has no scrollIntoView (component tests don't all stub it).
    tailRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turns.length])

  const send = useMutation({
    // Result unused (onSuccess only invalidates) — the explicit Promise<unknown>
    // unifies the two routes' otherwise-incompatible response types.
    mutationFn: (text: string): Promise<unknown> =>
      isK ? api.k.ask(text, { threadId }) : api.conversations.message(profileId, { body: text, threadId }),
    onSuccess: () => {
      // Clear the draft on SUCCESS only — a failed send keeps the operator's text
      // (useAskK's documented posture; quality review M3).
      setDraft('')
      void qc.invalidateQueries({ queryKey: ['k-thread', threadId] })
      void qc.invalidateQueries({ queryKey: ['k-threads'] })
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  // An agent send only QUEUES a mailbox row — the durable turn appears when the
  // relay delivers (possibly held behind a live run). Show an honest "queued" note
  // after a successful agent send; clear it once the transcript grows.
  useEffect(() => {
    if (send.isSuccess) send.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length])

  function submit() {
    const text = draft.trim()
    if (!text || send.isPending) return
    send.mutate(text)
  }

  /** Sender label for one turn: k-role → the agent's name; user-role → the parsed
   *  provenance sender ('user' → You), or You when untagged (a direct ask). */
  function senderLabel(role: string, sender: string | null): string {
    if (role !== 'user') return agentName
    if (sender == null || sender === 'user') return 'You'
    return sender
  }

  return (
    <div data-testid="conversation-view" className="flex min-h-0 flex-1 flex-col">
      {/* Session chip + context meter — rendered ONLY when the caller supplied a
          real session state. Home passes neither (its K session state isn't in
          agent_sessions), and fabricating an "idle" pill there would contradict
          the repo's never-fabricate-status posture (quality review M6). */}
      {(sessionState != null || contextTokens != null) && (
        <div className="flex items-center gap-2 pb-2">
          {sessionState != null && (
            <span
              data-testid="conversation-session-chip"
              className={`flex items-center gap-1.5 rounded-pill border border-border bg-raised px-2 py-0.5 text-micro font-semibold uppercase tracking-wide ${
                sessionState === 'live' ? 'text-green' : 'text-muted'
              }`}
            >
              {sessionState === 'live' && (
                <span className="glow-live inline-block h-1.5 w-1.5 rounded-pill bg-green" aria-hidden />
              )}
              {sessionState}
            </span>
          )}
          {contextTokens != null && (
            <span data-testid="conversation-ctx-meter" className="mono text-micro text-muted">
              {(contextTokens / 1000).toFixed(1)}k ctx
            </span>
          )}
        </div>
      )}

      {/* Transcript */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {dayGroups.map(group => (
          <div key={group.key} className="space-y-2.5">
            <div data-testid="conversation-day-separator" className="micro-label text-center text-muted">
              {group.label}
            </div>
            {group.items.flatMap(t => {
              // One turn may carry a relay BATCH — render each provenance segment
              // as its own bubble so every message keeps its true sender/priority.
              const segments = splitProvenanceSegments(t.text)
              return segments.map((seg, i) => {
                const { sender, priority, rest } = parseProvenance(seg)
                const label = senderLabel(t.role, sender)
                const mine = t.role === 'user' && (sender == null || sender === 'user')
                return (
                  <div
                    key={`${t.id}:${i}`}
                    data-testid={mine ? 'conversation-turn-user' : 'conversation-turn-agent'}
                    className={`flex flex-col gap-0.5 ${mine ? 'items-end' : 'items-start'}`}
                  >
                    <span className="flex items-baseline gap-1.5 text-caption font-semibold uppercase tracking-wide text-muted">
                      {label}
                      {priority === 'urgent' && (
                        <span className="rounded-pill bg-amber/20 px-1.5 text-micro text-amber">urgent</span>
                      )}
                      <span className="mono text-micro font-normal normal-case text-muted">
                        {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap rounded-control px-3 py-2 text-body ${
                        mine ? 'bg-accent/15 text-text' : 'border border-border bg-raised text-text'
                      }`}
                    >
                      {unescapeProvenanceLookalikes(rest)}
                    </div>
                    {/* A turn produced by/for a run keeps its action chip (ChatView parity). */}
                    {i === segments.length - 1 && t.runId && (
                      <button type="button" data-testid="conversation-run-chip" onClick={() => navigate('runs', t.runId!)}>
                        <Tag tint="sky">→ view run</Tag>
                      </button>
                    )}
                  </div>
                )
              })
            })}
          </div>
        ))}
        <div ref={tailRef} />
      </div>

      {/* Composer + send status (error keeps the draft; queued = honest mailbox state) */}
      {showComposer && send.isError && (
        <div data-testid="conversation-send-error" className="pt-2 text-caption text-red">
          Send failed — {send.error instanceof Error ? send.error.message : String(send.error)}. Your message is still in the box.
        </div>
      )}
      {showComposer && !isK && send.isSuccess && (
        <div data-testid="conversation-queued-note" className="pt-2 text-caption text-muted">
          Queued — delivered when {agentName} next wakes.
        </div>
      )}
      {showComposer && (
        <div className="flex gap-2 pt-2">
          <Input
            data-testid="conversation-composer-input"
            aria-label={`Message ${agentName}`}
            placeholder={`Message ${agentName}…`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            className="min-w-0 flex-1"
          />
          <Button
            data-testid="conversation-composer-send"
            icon="send"
            disabled={draft.trim().length === 0 || send.isPending}
            onClick={submit}
          >
            Send
          </Button>
        </div>
      )}
    </div>
  )
}
