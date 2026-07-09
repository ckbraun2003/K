/**
 * P2 B1 — the Approvals Inbox union. Pure read over seeded rows: all five kinds
 * at once, per-kind counts, dismissal semantics (review stamp; mcp hash-pin that
 * config drift re-surfaces).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, runPlansDb, projectsDb, eventsDb } from '../src/db.js'
import type { InboxPayload } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const pid = randomUUID()
const planRun = randomUUID(), inputRun = randomUUID(), reviewRun = randomUUID(), reviewedRun = randomUUID()
const lessonId = randomUUID()
const mcpKey = `user:p2-inbox-${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  projectsDb.insertProject.run({ id: pid, name: `p2b-${pid.slice(0, 8)}`, localPath: 'C:\\nowhere\\p2b',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
  const base = { cwd: 'C:\\nowhere\\p2b', worktree: null, provider: 'claude', model: 'm',
    tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid }
  runsDb.insertRun.run({ ...base, id: planRun, prompt: 'plan-gated feature', status: 'awaiting_plan', createdAt: 1000 })
  runPlansDb.insertRunPlan.run({ runId: planRun, plan: JSON.stringify({ steps: [{ title: 'a' }, { title: 'b' }], files: [], risk: 'high' }),
    raw: 'r', edited: 0, profileId: null, createdAt: 4000, updatedAt: 4000 })
  runsDb.insertRun.run({ ...base, id: inputRun, prompt: 'interactive question', status: 'awaiting_input', createdAt: 3000 })
  runsDb.insertRun.run({ ...base, id: reviewRun, prompt: 'finished work', status: 'done', createdAt: 1000 })
  db.prepare(`UPDATE runs SET ended_at = 2000 WHERE id = ?`).run(reviewRun)
  eventsDb.insertEvent.run({ id: randomUUID(), runId: reviewRun, seq: 3, type: 'checkpoint', ts: 1500,
    raw: JSON.stringify({ sha: 'a'.repeat(40), tree: 'b'.repeat(40), ref: `refs/k-checkpoints/${reviewRun}`, wave: 1 }),
    text: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null, toolKind: null,
    toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null, childLabel: null, contextTokens: null })
  // done + checkpoints but ALREADY reviewed → must NOT appear:
  runsDb.insertRun.run({ ...base, id: reviewedRun, prompt: 'old done', status: 'done', createdAt: 900 })
  db.prepare(`UPDATE runs SET reviewed_at = 950 WHERE id = ?`).run(reviewedRun)
  db.prepare(`INSERT INTO agent_memory (id, run_id, lesson, status, created_at) VALUES (?, NULL, 'always wipe the data dir', 'pending', 5000)`).run(lessonId)
  db.prepare(`INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, config_hash, discovered_at)
              VALUES (?, 'p2-server', ?, 'claude-user', NULL, 'npx', 'hash-v1', 6000)`).run(randomUUID(), mcpKey)
})
afterAll(async () => {
  for (const id of [planRun, inputRun, reviewRun, reviewedRun]) {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM run_plans WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
  db.prepare('DELETE FROM agent_memory WHERE id = ?').run(lessonId)
  db.prepare('DELETE FROM host_mcp_servers WHERE qualified_key = ?').run(mcpKey)
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
  await app.close()
})

async function fetchInbox(): Promise<InboxPayload> {
  const res = await app.inject({ method: 'GET', url: '/api/inbox', headers: AUTH })
  expect(res.statusCode).toBe(200)
  return res.json() as InboxPayload
}

describe('GET /api/inbox', () => {
  it('unions all five kinds with typed payloads, counts, and ts-desc order', async () => {
    const inbox = await fetchInbox()
    const mine = inbox.items.filter(i =>
      ('runId' in i && [planRun, inputRun, reviewRun].includes(i.runId))
      || (i.kind === 'lesson_pending' && i.lessonId === lessonId)
      || (i.kind === 'mcp_trust' && i.qualifiedKey === mcpKey))
    expect(mine.map(i => i.kind).sort()).toEqual(
      ['input_needed', 'lesson_pending', 'mcp_trust', 'plan_pending', 'review_ready'])
    const plan = mine.find(i => i.kind === 'plan_pending')!
    expect(plan).toMatchObject({ risk: 'high', steps: 2, edited: false, projectName: expect.stringContaining('p2b-') })
    expect(mine.find(i => i.kind === 'review_ready')).toMatchObject({ runId: reviewRun, verifyStatus: null })
    // the already-reviewed done run is absent:
    expect(inbox.items.some(i => i.kind === 'review_ready' && i.runId === reviewedRun)).toBe(false)
    expect(inbox.counts.plan_pending).toBeGreaterThanOrEqual(1)
    expect(inbox.total).toBe(
      inbox.counts.plan_pending + inbox.counts.input_needed + inbox.counts.lesson_pending
      + inbox.counts.mcp_trust + inbox.counts.review_ready)
    // ts DESC across kinds:
    const ts = inbox.items.map(i => i.ts)
    expect([...ts].sort((a, b) => b - a)).toEqual(ts)
  })
})

describe('dismissals', () => {
  it('review dismiss stamps reviewed_at (idempotent 204) and removes the card', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/inbox/runs/${reviewRun}/dismiss-review`, headers: AUTH })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `/api/inbox/runs/${reviewRun}/dismiss-review`, headers: AUTH })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `/api/inbox/runs/${randomUUID()}/dismiss-review`, headers: AUTH })).statusCode).toBe(404)
    expect((await fetchInbox()).items.some(i => i.kind === 'review_ready' && i.runId === reviewRun)).toBe(false)
  })

  it('mcp dismiss pins the config hash; drift re-surfaces the card', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/inbox/mcp/${encodeURIComponent(mcpKey)}/dismiss`, headers: AUTH })).statusCode).toBe(204)
    expect((await fetchInbox()).items.some(i => i.kind === 'mcp_trust' && i.qualifiedKey === mcpKey)).toBe(false)
    db.prepare(`UPDATE host_mcp_servers SET config_hash = 'hash-v2' WHERE qualified_key = ?`).run(mcpKey)
    expect((await fetchInbox()).items.some(i => i.kind === 'mcp_trust' && i.qualifiedKey === mcpKey)).toBe(true)
    expect((await app.inject({ method: 'POST', url: `/api/inbox/mcp/${encodeURIComponent('user:absent')}/dismiss`, headers: AUTH })).statusCode).toBe(404)
  })
})
