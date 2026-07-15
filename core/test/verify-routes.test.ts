/**
 * P1 B1 — E-04 verify routes: GET /api/runs/:id/verify-result (404 run / 200
 * {result:null} never-verified / 200 seeded row) + PATCH /api/projects/:id/verify-recipe (400
 * schema-invalid BEFORE 404 unknown project — F-022 ordering; 200 set echoes
 * the recipe; 200 clear removes it). Real Fastify app via buildApp + inject.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, projectsDb, verifyResultsDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
let projectId: string
let runId: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  projectId = randomUUID()
  projectsDb.insertProject.run({
    id: projectId, name: `verify-routes-${projectId.slice(0, 8)}`, localPath: process.cwd(),
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now(),
  })
  runId = randomUUID()
  runsDb.insertRun.run({ id: runId, prompt: 'x', cwd: process.cwd(), worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
})

afterAll(async () => {
  try { db.prepare('DELETE FROM verify_results WHERE run_id = ?').run(runId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM runs WHERE id = ?').run(runId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) } catch { /* ignore */ }
  await app.close()
})

describe('GET /api/runs/:id/verify-result', () => {
  it('404 for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/verify-result`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('not found')
  })

  it('200 { result: null } for a known run never verified (BE-3c contract)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/verify-result`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: null })
  })

  it('200 with the stored result after a seeded upsert', async () => {
    const startedAt = Date.now()
    verifyResultsDb.upsertVerifyResult.run({
      runId, status: 'pass', reason: null,
      commands: JSON.stringify([{ label: 't', run: 'node -e ""', exitCode: 0, ok: true, durationMs: 5, outputTail: '' }]),
      scope: JSON.stringify({ files: ['a.txt'], symbols: null, indexed: false }),
      startedAt, completedAt: startedAt + 10,
    })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/verify-result`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ runId, status: 'pass', startedAt, completedAt: startedAt + 10 })
    expect(body.commands).toHaveLength(1)
    expect(body.commands[0]).toMatchObject({ label: 't', ok: true, exitCode: 0 })
    expect(body.scope).toEqual({ files: ['a.txt'], symbols: null, indexed: false })
  })
})

describe('PATCH /api/projects/:id/verify-recipe', () => {
  it('400 for a schema-invalid recipe (empty commands) — body BEFORE existence', async () => {
    // Unknown project id + bad body ⇒ still 400 (F-022 ordering).
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${randomUUID()}/verify-recipe`, headers: AUTH,
      payload: { recipe: { commands: [] } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('404 for an unknown project with a valid body', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${randomUUID()}/verify-recipe`, headers: AUTH,
      payload: { recipe: { commands: [{ label: 'tc', run: 'pnpm typecheck' }] } },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('not found')
  })

  it('200 set: the response project echoes the recipe', async () => {
    const recipe = { commands: [{ label: 'tc', run: 'pnpm typecheck' }], timeoutMs: 60_000 }
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}/verify-recipe`, headers: AUTH,
      payload: { recipe },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(projectId)
    expect(body.verifyRecipe).toEqual(recipe)
  })

  it('200 clear: {recipe:null} removes it (verifyRecipe absent)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}/verify-recipe`, headers: AUTH,
      payload: { recipe: null },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(projectId)
    expect(body.verifyRecipe).toBeUndefined()
  })
})
