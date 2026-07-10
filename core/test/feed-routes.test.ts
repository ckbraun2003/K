/**
 * P3 B1 — the Org Timeline feed union. Pure read over seeded rows: run-head kinds,
 * notification review_ready, verify pass/fail, an OPEN-PR github_cache row, per-kind
 * counts, ts-desc order, the kinds filter, and the informational current-runStatus carry.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, projectsDb, verifyResultsDb, notificationsDb } from '../src/db.js'
import type { FeedPayload } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })
const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
let app: FastifyInstance
const pid = randomUUID()
const runningRun = randomUUID(), parkRun = randomUUID(), doneRun = randomUUID(), failRun = randomUUID()
const planRun = randomUUID()
const notifId = randomUUID()

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
  projectsDb.insertProject.run({ id: pid, name: `p3feed-${pid.slice(0, 8)}`, localPath: 'C:\\nowhere\\feed',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
  const base = { cwd: 'C:\\nowhere\\feed', worktree: null, provider: 'claude', model: 'm',
    tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: pid }
  runsDb.insertRun.run({ ...base, id: runningRun, prompt: 'live run', status: 'running', createdAt: 5000 })
  runsDb.insertRun.run({ ...base, id: parkRun, prompt: 'awaiting input', status: 'awaiting_input', createdAt: 4000 })
  runsDb.insertRun.run({ ...base, id: doneRun, prompt: 'finished work', status: 'done', createdAt: 1000 })
  db.prepare(`UPDATE runs SET ended_at = 3000 WHERE id = ?`).run(doneRun)
  runsDb.insertRun.run({ ...base, id: failRun, prompt: 'broke', status: 'error', createdAt: 900 })
  db.prepare(`UPDATE runs SET ended_at = 2000 WHERE id = ?`).run(failRun)
  runsDb.insertRun.run({ ...base, id: planRun, prompt: 'awaiting plan', status: 'awaiting_plan', createdAt: 4500 })
  verifyResultsDb.upsertVerifyResult.run({ runId: doneRun, status: 'pass', reason: null,
    commands: '[]', scope: null, startedAt: 1, completedAt: 3500 })
  verifyResultsDb.upsertVerifyResult.run({ runId: failRun, status: 'fail', reason: 'boom',
    commands: '[]', scope: null, startedAt: 1, completedAt: 1950 })
  notificationsDb.insertNotification.run({ id: notifId, eventKey: 'run_review_ready', title: 'Ready for review',
    body: null, runId: doneRun, projectId: pid, createdAt: 3600, readAt: null })
  db.prepare(`INSERT INTO github_cache (project_id, kind, payload, fetched_at) VALUES (?, 'pr', ?, ?)`)
    .run(pid, JSON.stringify([{ number: 7, title: 'Add hello.js', state: 'OPEN', url: 'https://x', checks: 'none' }]), 6000)
})
afterAll(async () => {
  for (const id of [runningRun, parkRun, doneRun, failRun, planRun]) {
    db.prepare('DELETE FROM verify_results WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
  db.prepare('DELETE FROM notifications WHERE id = ?').run(notifId)
  db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(pid)
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
  await app.close()
})

async function fetchFeed(qs = ''): Promise<FeedPayload> {
  const res = await app.inject({ method: 'GET', url: `/api/feed${qs}`, headers: AUTH })
  expect(res.statusCode).toBe(200)
  return res.json() as FeedPayload
}

describe('GET /api/feed', () => {
  it('projects run-head kinds + review_ready + verify_pass, ts DESC, current runStatus carried', async () => {
    const feed = await fetchFeed()
    const mine = feed.items.filter(i => i.projectId === pid)
    const byRun = (rid: string) => mine.filter(i => i.runId === rid)
    expect(byRun(runningRun).some(i => i.kind === 'dispatch' && i.runStatus === 'running')).toBe(true)
    expect(byRun(parkRun).some(i => i.kind === 'park' && i.runStatus === 'awaiting_input')).toBe(true)
    expect(byRun(doneRun).some(i => i.kind === 'done')).toBe(true)
    expect(byRun(failRun).some(i => i.kind === 'failure')).toBe(true)
    expect(byRun(planRun).some(i => i.kind === 'plan_gate' && i.runStatus === 'awaiting_plan')).toBe(true)
    expect(mine.some(i => i.kind === 'review_ready' && i.runId === doneRun)).toBe(true)
    expect(mine.some(i => i.kind === 'verify_pass' && i.runId === doneRun)).toBe(true)
    expect(mine.some(i => i.kind === 'verify_fail' && i.runId === failRun && i.detail === 'verify failed')).toBe(true)
    expect(mine.some(i => i.kind === 'pr' && i.detail === '#7' && i.runId === null)).toBe(true)
    const ts = feed.items.map(i => i.ts)
    expect([...ts].sort((a, b) => b - a)).toEqual(ts)
    expect(feed.total).toBe(Object.values(feed.counts).reduce((a, b) => a + b, 0))
    // 'merge' is a reserved kind with no P3 producer -> always 0.
    expect(feed.counts.merge).toBe(0)
  })
  it('the kinds filter narrows items AND counts', async () => {
    const feed = await fetchFeed('?kinds=verify_pass')
    expect(feed.items.every(i => i.kind === 'verify_pass')).toBe(true)
    expect(feed.counts.dispatch).toBe(0)
    expect(feed.counts.verify_pass).toBeGreaterThanOrEqual(1)
  })
  it('limit caps items but total stays the honest sum', async () => {
    const feed = await fetchFeed('?limit=1')
    expect(feed.items.length).toBe(1)
    expect(feed.total).toBeGreaterThanOrEqual(1)
  })
  it('a REPEATED kinds query key (?kinds=a&kinds=b) is normalized, not a 500', async () => {
    const feed = await fetchFeed('?kinds=verify_pass&kinds=verify_fail')
    expect(feed.items.every(i => i.kind === 'verify_pass' || i.kind === 'verify_fail')).toBe(true)
    expect(feed.counts.dispatch).toBe(0)
    expect(feed.counts.verify_pass + feed.counts.verify_fail).toBe(feed.total)
  })
  it('a provided limit is clamped into 1..500 (limit=0 -> 1, not the default 100)', async () => {
    const feed = await fetchFeed('?limit=0')
    expect(feed.items.length).toBe(1)
    expect(feed.total).toBeGreaterThanOrEqual(1)
  })
})
