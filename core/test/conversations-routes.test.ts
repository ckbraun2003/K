/**
 * /api/conversations + /api/agents/:profileId/{conversation,message}
 * (Continuous Agents B.5, D-123). buildApp + inject; K_SKIP_BOOTSTRAP.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ConversationSummarySchema } from '@k/shared'
import { db } from '../src/db.js'
import { createProfile, getProfile } from '../src/profiles.js'
import { ensureDefaultKThread, appendTurn, DEFAULT_K_THREAD_ID } from '../src/k-thread.js'
import { getOrCreateConversation } from '../src/agent-sessions.js'
import { ORG_DEFAULT_PROFILE_ID } from '../src/plan-gate.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' }
const AGENT = 'ca-b-conv-agent'

let app: FastifyInstance
const created: string[] = []

function cleanup() {
  db.prepare(`DELETE FROM agent_messages`).run()
  db.prepare(`DELETE FROM agent_sessions`).run()
  db.prepare(`DELETE FROM k_thread_turns`).run()
  db.prepare(`DELETE FROM k_threads`).run()
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  if (!getProfile('k-secretary')) { createProfile({ id: 'k-secretary', name: 'K', tier: 'secretary' }); created.push('k-secretary') }
  if (!getProfile(AGENT)) { createProfile({ id: AGENT, name: 'CaBConvAgent', tier: 'orchestrator' }); created.push(AGENT) }
  // Lane E fixture: the generic seeded default-orchestrator (profiles.ts:208) — a real
  // profile row here so its conversation exclusion is tested against an ACTUAL profile,
  // not merely a missing one (which listProfiles() would skip on its own).
  if (!getProfile(ORG_DEFAULT_PROFILE_ID)) {
    createProfile({ id: ORG_DEFAULT_PROFILE_ID, name: 'orchestrator', tier: 'orchestrator' })
    created.push(ORG_DEFAULT_PROFILE_ID)
  }
  // 30s: the index.js import + buildApp legitimately exceed the 10s default on a
  // loaded box (the domains-routes / session-id-capture hookTimeout precedent).
}, 30_000)
beforeEach(cleanup)
afterAll(async () => {
  cleanup()
  for (const id of created) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
  await app.close()
})

describe('GET /api/conversations', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/conversations' })).statusCode).toBe(401)
  })

  it('ensures each non-K durable profile has its single conversation and returns joined rows', async () => {
    ensureDefaultKThread()
    const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { conversations } = res.json() as { conversations: Array<Record<string, unknown>> }
    for (const c of conversations) expect(ConversationSummarySchema.safeParse(c).success).toBe(true)
    // K's default thread is owned by k-secretary; the agent's conversation was CREATED by the read.
    expect(conversations.some(c => c.id === DEFAULT_K_THREAD_ID && c.profileId === 'k-secretary')).toBe(true)
    const agentConv = conversations.find(c => c.profileId === AGENT)
    expect(agentConv).toBeDefined()
    expect(agentConv!.id).toBe(`kt-${AGENT}`)
    expect(agentConv!.profileName).toBe('CaBConvAgent')
    expect(agentConv!.sessionState).toBeNull() // no session row yet — the UI renders it idle
  })

  it('unread = turns newer than last_read_at + queued mailbox messages; archived excluded by default', async () => {
    const t = ensureDefaultKThread()
    const t0 = Date.now()
    appendTurn(t.id, 'user', 'q1', null)
    appendTurn(t.id, 'k', 'a1', null)
    db.prepare(`UPDATE k_threads SET last_read_at = ? WHERE id = ?`).run(t0 - 60_000, t.id)
    db.prepare(
      `INSERT INTO agent_messages (id, to_profile_id, to_thread_id, from_kind, from_profile_id, body, priority, status, provenance_run_id, created_at)
       VALUES ('ca-b-m1', 'k-secretary', ?, 'profile', 'chief', 'report', 'normal', 'queued', NULL, ?)`,
    ).run(t.id, Date.now())

    // The operator's OWN just-sent (still-queued) messages never count as unread —
    // queued counts are cursor-independent, so a from_kind='user' row would show a
    // +1 badge no read could ever clear.
    db.prepare(
      `INSERT INTO agent_messages (id, to_profile_id, to_thread_id, from_kind, from_profile_id, body, priority, status, provenance_run_id, created_at)
       VALUES ('ca-b-m2', 'k-secretary', ?, 'user', NULL, 'my own send', 'normal', 'queued', NULL, ?)`,
    ).run(t.id, Date.now())

    const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    const conv = (res.json().conversations as Array<Record<string, unknown>>).find(c => c.id === t.id)!
    expect(conv.unread).toBe(3) // 2 unread turns + 1 queued NON-user message

    // INT.2: a DELIVERED own-message must not badge either — once the relay lands
    // the operator's own block as a turn, the cursor-independent +1 would come
    // back as an unread TURN. A single-block user-tagged turn is excluded…
    appendTurn(t.id, 'user', '[message from user · normal] my own delivered send', null)
    const res2 = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    const conv2 = (res2.json().conversations as Array<Record<string, unknown>>).find(c => c.id === t.id)!
    expect(conv2.unread).toBe(3) // unchanged — the delivered own-message is silent

    // …a MULTI-own-message batch (2+ operator sends in one relay tick, one wake
    // turn) is STILL entirely the operator's own — silent too (SEAMS#1 m1)…
    appendTurn(t.id, 'user', '[message from user · normal] first own\n\n[message from user · urgent] second own', null)
    const res2b = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    const conv2b = (res2b.json().conversations as Array<Record<string, unknown>>).find(c => c.id === t.id)!
    expect(conv2b.unread).toBe(3)

    // …but a MIXED batch turn (operator block + an agent block) still counts: it
    // carries agent content the operator has not read.
    appendTurn(t.id, 'user', '[message from user · normal] mine\n\n[message from chief · normal] real report', null)
    const res3 = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    const conv3 = (res3.json().conversations as Array<Record<string, unknown>>).find(c => c.id === t.id)!
    expect(conv3.unread).toBe(4)

    // Archived threads are excluded by default, included with ?archived=1.
    db.prepare(`UPDATE k_threads SET archived_at = ? WHERE id = ?`).run(Date.now(), t.id)
    const def = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    expect((def.json().conversations as Array<Record<string, unknown>>).some(c => c.id === t.id)).toBe(false)
    const all = await app.inject({ method: 'GET', url: '/api/conversations?archived=1', headers: AUTH })
    expect((all.json().conversations as Array<Record<string, unknown>>).some(c => c.id === t.id)).toBe(true)
  })

  it('excludes the generic default-orchestrator: never force-created, and hidden even if a conversation already exists (Lane E fix)', async () => {
    // The read auto-ensures every non-K profile's conversation — ORG_DEFAULT_PROFILE_ID
    // must NOT get one, unlike every other durable profile (AGENT, above).
    const res = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { conversations } = res.json() as { conversations: Array<Record<string, unknown>> }
    expect(conversations.some(c => c.profileId === ORG_DEFAULT_PROFILE_ID)).toBe(false)
    expect(db.prepare(`SELECT 1 FROM k_threads WHERE profile_id = ?`).get(ORG_DEFAULT_PROFILE_ID)).toBeUndefined()

    // Even a PRE-EXISTING generic conversation (created directly, bypassing the ensure
    // loop above — e.g. leftover pre-fix data) must stay hidden from BOTH the default
    // list and the ?archived=1 list.
    const generic = getOrCreateConversation(ORG_DEFAULT_PROFILE_ID)
    const res2 = await app.inject({ method: 'GET', url: '/api/conversations', headers: AUTH })
    expect((res2.json().conversations as Array<Record<string, unknown>>).some(c => c.id === generic.id)).toBe(false)
    const res3 = await app.inject({ method: 'GET', url: '/api/conversations?archived=1', headers: AUTH })
    expect((res3.json().conversations as Array<Record<string, unknown>>).some(c => c.id === generic.id)).toBe(false)
  })
})

describe('POST /api/conversations/:threadId/read', () => {
  it('advances the cursor, clamped MONOTONIC and never beyond now', async () => {
    const t = ensureDefaultKThread()
    const t2 = Date.now() - 1_000
    db.prepare(`UPDATE k_threads SET last_read_at = ? WHERE id = ?`).run(t2, t.id)
    const updatedAtBefore = (db.prepare(`SELECT updated_at FROM k_threads WHERE id = ?`).get(t.id) as { updated_at: number }).updated_at

    // Backwards attempt (t2 - 5000) is clamped — the cursor must NOT move back.
    const back = await app.inject({
      method: 'POST', url: `/api/conversations/${t.id}/read`, headers: JSON_AUTH,
      payload: { at: t2 - 5_000 },
    })
    expect(back.statusCode).toBe(200)
    expect((db.prepare(`SELECT last_read_at FROM k_threads WHERE id = ?`).get(t.id) as { last_read_at: number }).last_read_at).toBe(t2)

    // Far-future attempt is clamped to now.
    const future = await app.inject({
      method: 'POST', url: `/api/conversations/${t.id}/read`, headers: JSON_AUTH,
      payload: { at: Date.now() + 10 * 60_000 },
    })
    expect(future.statusCode).toBe(200)
    const cur = (db.prepare(`SELECT last_read_at FROM k_threads WHERE id = ?`).get(t.id) as { last_read_at: number }).last_read_at
    expect(cur).toBeGreaterThanOrEqual(t2)
    expect(cur).toBeLessThanOrEqual(Date.now())

    // Default body → now.
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${t.id}/read`, headers: JSON_AUTH, payload: {} })
    expect(res.statusCode).toBe(200)

    // Reading NEVER bumps updated_at — a read must not reorder the conversation list.
    expect(
      (db.prepare(`SELECT updated_at FROM k_threads WHERE id = ?`).get(t.id) as { updated_at: number }).updated_at,
    ).toBe(updatedAtBefore)
  })

  it('404 unknown thread · 400 bad body', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/conversations/nope/read', headers: JSON_AUTH, payload: {} })).statusCode).toBe(404)
    const t = ensureDefaultKThread()
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${t.id}/read`, headers: JSON_AUTH, payload: { at: 'soon' } })).statusCode).toBe(400)
  })

  it('the thread-scoped message index backs the list unread math (order pinned)', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_messages_thread'`)
      .get() as { sql: string } | undefined
    expect(row?.sql).toMatch(/agent_messages\s*\(\s*to_thread_id\s*,\s*status\s*\)/)
  })
})

describe('GET /api/agents/:profileId/conversation', () => {
  it('get-or-creates the single conversation (embed entry point) · 404 unknown profile', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${AGENT}/conversation`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { conversation } = res.json() as { conversation: Record<string, unknown> }
    expect(ConversationSummarySchema.safeParse(conversation).success).toBe(true)
    expect(conversation.id).toBe(`kt-${AGENT}`)
    expect((await app.inject({ method: 'GET', url: '/api/agents/ca-b-nobody/conversation', headers: AUTH })).statusCode).toBe(404)
  })
})

describe('POST /api/agents/:profileId/message', () => {
  it('queues the operator message, resolves the conversation, stamps the title on first send', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/agents/${AGENT}/message`, headers: JSON_AUTH,
      payload: { body: 'please pick up the review backlog', priority: 'urgent' },
    })
    expect(res.statusCode).toBe(201)
    const { message, threadId } = res.json() as { message: Record<string, unknown>; threadId: string }
    expect(threadId).toBe(`kt-${AGENT}`)
    expect(message.fromKind).toBe('user')
    expect(message.priority).toBe('urgent')
    expect(message.status).toBe('queued')
    // Title-on-first-send (the W0.3 Lane B checklist item — the adapter leaves it NULL).
    const th = db.prepare(`SELECT title FROM k_threads WHERE id = ?`).get(threadId) as { title: string | null }
    expect(th.title).toBe('please pick up the review backlog')
    // Second send must NOT restamp.
    await app.inject({ method: 'POST', url: `/api/agents/${AGENT}/message`, headers: JSON_AUTH, payload: { body: 'and another thing' } })
    expect((db.prepare(`SELECT title FROM k_threads WHERE id = ?`).get(threadId) as { title: string | null }).title)
      .toBe('please pick up the review backlog')
  })

  it('404 unknown profile · 400 bad body · 400 foreign threadId', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/agents/ca-b-nobody/message', headers: JSON_AUTH, payload: { body: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/agents/${AGENT}/message`, headers: JSON_AUTH, payload: {} })).statusCode).toBe(400)
    const kThread = ensureDefaultKThread()
    const res = await app.inject({
      method: 'POST', url: `/api/agents/${AGENT}/message`, headers: JSON_AUTH,
      payload: { body: 'x', threadId: kThread.id }, // K's thread, not the agent's
    })
    expect(res.statusCode).toBe(400)
  })
})
