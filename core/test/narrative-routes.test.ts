/** P3 A1 - GET /api/runs/:id/narrative over seeded rows (no spawn, no real Ollama). */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, verifyResultsDb } from '../src/db.js'
import type { RunNarrative } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })
const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
let app: FastifyInstance
const rid = randomUUID()

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
  runsDb.insertRun.run({ id: rid, prompt: 'Create hello.js that prints hello', cwd: 'C:\\nowhere',
    worktree: null, status: 'done', provider: 'claude', model: 'm', tokensIn: 1200, tokensOut: 340,
    costUsd: 0.0031, projectId: null, createdAt: 1000 })
  db.prepare(`UPDATE runs SET ended_at = 1600 WHERE id = ?`).run(rid)
  verifyResultsDb.upsertVerifyResult.run({ runId: rid, status: 'pass', reason: null,
    commands: '[{"label":"t","run":"x","exitCode":0,"ok":true,"durationMs":1,"outputTail":""}]',
    scope: '{"files":["hello.js"],"symbols":null,"indexed":false}', startedAt: 1, completedAt: 2 })
})
afterAll(async () => {
  db.prepare('DELETE FROM verify_results WHERE run_id = ?').run(rid)
  db.prepare('DELETE FROM runs WHERE id = ?').run(rid)
  await app.close()
})

describe('GET /api/runs/:id/narrative', () => {
  it('404s an unknown run', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/narrative`, headers: AUTH })).statusCode).toBe(404)
  })
  it('returns deterministic fields always; bullets omitted with an honest state when no local model', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${rid}/narrative`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const n = res.json() as RunNarrative
    expect(n.goal).toContain('Create hello.js')
    expect(n.outcome).toEqual({ status: 'done', endedAt: 1600, durationMs: 600 })
    expect(n.files).toEqual(['hello.js'])
    expect(n.verification).toMatchObject({ status: 'pass', commandCount: 1 })
    expect(n.cost.costUsd).toBeCloseTo(0.0031)
    expect(n.bullets).toBeNull()
    expect(['disabled', 'unavailable']).toContain(n.bulletsState) // CI has no local model
  })
})
