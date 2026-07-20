import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import {
  ConversationReadBodySchema,
  AgentMessageSendBodySchema,
  type ConversationSummary,
} from '@k/shared'
import { db, kThreadsDb } from '../db.js'
import { rowToKThread } from '../k-thread.js'
import { getOrCreateConversation } from '../agent-sessions.js'
import { assertSafeSegment } from '../agent-config.js'
import { getProfile, listProfiles } from '../profiles.js'
import { queueMessage, mayMessage, AgentMailError } from '../agent-mail.js'
import { sendError, sendZodError } from './http-errors.js'

type Row = Record<string, unknown>

// One joined read for the whole surface: thread + owning profile + session state +
// snippet/lastTurnAt preview + unread math (turns newer than the read cursor + queued
// NON-operator mailbox messages addressed to this conversation — the operator's own
// just-sent rows are excluded, else their badge would show +1 that no read can clear
// (queued counts are cursor-independent until the relay delivers). Local statements —
// the frozen W0 db bundles stay untouched (the getDelegatingKRunForPipeline precedent).
const CONVERSATION_SELECT = `
  SELECT th.*, p.name AS profile_name,
    s.state AS session_state, s.context_tokens AS session_context_tokens,
    (SELECT t.text FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS snippet,
    (SELECT t.created_at FROM k_thread_turns t WHERE t.thread_id = th.id ORDER BY t.created_at DESC LIMIT 1) AS last_turn_at,
    (SELECT COUNT(*) FROM k_thread_turns t WHERE t.thread_id = th.id AND t.created_at > COALESCE(th.last_read_at, 0)
       -- INT.2 (+SEAMS#1 m1): a DELIVERED own-message must not badge (B.5 excluded
       -- queued rows only; once the relay lands the turn it counted again). A turn
       -- is the operator's own when it starts with the user tag AND every embedded
       -- block head is ALSO the user tag (a multi-own-message batch stays silent;
       -- the replace() strips user heads, so any REMAINING head is agent content
       -- and the turn counts). Escaped in-body lookalikes (message-relay escaping)
       -- can't fake a block head here.
       AND NOT (t.text LIKE '[message from user ·%'
                AND instr(replace(t.text, char(10) || char(10) || '[message from user ·', ''),
                          char(10) || char(10) || '[message from ') = 0)) AS unread_turns,
    (SELECT COUNT(*) FROM agent_messages m WHERE m.status = 'queued' AND m.to_thread_id = th.id AND m.from_kind <> 'user') AS queued_msgs
  FROM k_threads th
  LEFT JOIN agent_profiles p ON p.id = th.profile_id
  LEFT JOIN agent_sessions s ON s.profile_id = th.profile_id AND s.thread_id = th.id`
const listConversations = db.prepare(`${CONVERSATION_SELECT} WHERE th.archived_at IS NULL ORDER BY th.updated_at DESC`)
const listConversationsAll = db.prepare(`${CONVERSATION_SELECT} ORDER BY th.updated_at DESC`)
const getConversation = db.prepare(`${CONVERSATION_SELECT} WHERE th.id = ?`)
// The MONOTONIC read cursor (the W0.1 ledger note: kThreadsDb.setLastReadAt has no
// clamp, so the route's statement carries it): never backwards. Never bumps
// updated_at — reading must not reorder the list.
const clampLastReadAt = db.prepare(
  `UPDATE k_threads SET last_read_at = @at WHERE id = @id AND (last_read_at IS NULL OR last_read_at < @at)`,
)
const getLastReadAt = db.prepare(`SELECT last_read_at FROM k_threads WHERE id = ?`)

function rowToConversation(r: Row): ConversationSummary {
  return {
    ...rowToKThread(r),
    snippet: r.snippet == null ? null : String(r.snippet),
    lastTurnAt: r.last_turn_at == null ? null : Number(r.last_turn_at),
    profileId: String(r.profile_id),
    profileName: r.profile_name == null ? null : String(r.profile_name),
    sessionState: r.session_state == null ? null : (r.session_state as ConversationSummary['sessionState']),
    contextTokens: r.session_context_tokens == null ? null : Number(r.session_context_tokens),
    unread: Number(r.unread_turns) + Number(r.queued_msgs),
  }
}

/** Get-or-create every non-K durable profile's single conversation (idempotent,
 *  bounded by the profile count) — the Messages list shows one row per durable
 *  agent even before any message exists. K keeps explicit multi-thread. */
function ensureProfileConversations(log: FastifyBaseLogger): void {
  for (const p of listProfiles()) {
    if (p.id === 'k-secretary') continue
    try {
      getOrCreateConversation(p.id)
    } catch (e) {
      // An unsafe legacy id (or a foreign-owned kt-<id> thread) must not break the
      // list — but never silently: the skipped profile is visible in the logs.
      log.warn({ err: e, profileId: p.id }, 'conversation ensure skipped')
    }
  }
}

/**
 * The Conversations surface (Continuous Agents B.5, D-123):
 *   GET  /api/conversations                    — all conversations (?archived=1 includes archived)
 *   POST /api/conversations/:threadId/read     — advance the read cursor (monotonic clamp)
 *   GET  /api/agents/:profileId/conversation   — get-or-create the agent's single conversation
 *   POST /api/agents/:profileId/message        — operator → mailbox (the relay delivers)
 * All ride the global Bearer hook (index.ts buildApp). K threads keep /api/k/ask as
 * the interactive path; the transcript read stays GET /api/k/threads/:id (generic).
 */
export async function conversationsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { archived?: string } }>('/api/conversations', async (req, reply) => {
    try {
      ensureProfileConversations(req.log)
      const rows = (req.query.archived === '1' ? listConversationsAll : listConversations).all() as Row[]
      return reply.send({ conversations: rows.map(rowToConversation) })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'conversations read failed')
    }
  })

  // F-022 ordering: body validated FIRST (400), then existence (404).
  app.post<{ Params: { threadId: string } }>('/api/conversations/:threadId/read', async (req, reply) => {
    const parsed = ConversationReadBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const { threadId } = req.params
      if (!kThreadsDb.getThread.get(threadId)) return sendError(reply, 404, 'not found')
      // Clamp: never beyond now (a poisoned future cursor hides all unread forever);
      // the statement's WHERE clamps monotonic (never backwards).
      const at = Math.min(parsed.data.at ?? Date.now(), Date.now())
      clampLastReadAt.run({ id: threadId, at })
      const row = getLastReadAt.get(threadId) as { last_read_at: number | null }
      return reply.send({ ok: true, lastReadAt: row.last_read_at })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'read-cursor update failed')
    }
  })

  app.get<{ Params: { profileId: string } }>('/api/agents/:profileId/conversation', async (req, reply) => {
    try {
      const profile = getProfile(req.params.profileId)
      if (!profile) return sendError(reply, 404, 'not found')
      // A legacy profile id failing the path-segment rule can never own a
      // conversation (agent-config's one-source validation) — caller error, not 500.
      try { assertSafeSegment(profile.id, 'profileId') } catch { return sendError(reply, 400, 'unsafe legacy profile id') }
      const thread = getOrCreateConversation(profile.id)
      const row = getConversation.get(thread.id) as Row
      return reply.send({ conversation: rowToConversation(row) })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'conversation read failed')
    }
  })

  app.post<{ Params: { profileId: string } }>('/api/agents/:profileId/message', async (req, reply) => {
    const parsed = AgentMessageSendBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const profile = getProfile(req.params.profileId)
      if (!profile) return sendError(reply, 404, 'not found')
      // Same unsafe-legacy-id guard as the conversation GET (one-source validation).
      try { assertSafeSegment(profile.id, 'profileId') } catch { return sendError(reply, 400, 'unsafe legacy profile id') }
      // user → anyone (the matrix's first row) — kept explicit so the gate is one
      // boundary convention everywhere, not an implied special case.
      if (!mayMessage({ kind: 'user' }, profile.id)) return sendError(reply, 403, 'not permitted')
      const threadId = parsed.data.threadId ?? getOrCreateConversation(profile.id).id
      const message = queueMessage({
        toProfileId: profile.id,
        toThreadId: threadId,
        from: { kind: 'user' },
        body: parsed.data.body,
        priority: parsed.data.priority,
      })
      // Title-on-first-send for non-K conversations (the adapter leaves title NULL —
      // W0.3 Lane B checklist). Guarded on title == null so it fires exactly once.
      if (profile.id !== 'k-secretary') {
        const th = kThreadsDb.getThread.get(threadId) as Row | undefined
        if (th && th.title == null) {
          kThreadsDb.setThreadTitle.run(parsed.data.body.slice(0, 60), Date.now(), threadId)
        }
      }
      return reply.status(201).send({ message, threadId })
    } catch (e) {
      if (e instanceof AgentMailError) return sendError(reply, 400, e.message)
      req.log.error(e)
      return sendError(reply, 500, 'message send failed')
    }
  })
}
