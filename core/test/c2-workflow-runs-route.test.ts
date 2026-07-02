/**
 * C2 — GET /api/workflows/runs (routes/workflows.ts): the recent workflow-runs list
 * the web run-picker uses to know WHICH runs were workflow-dispatched.
 *
 * Builds the real Fastify app in-process (buildApp) so the route rides the global
 * Bearer hook (the 401 case) — unlike workflows-defs-route.test.ts's bare-Fastify
 * harness. No dispatch happens here, so no supervisor mock. Rows are seeded directly
 * and cleaned in afterAll (shared K_DATA_DIR discipline).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import type { WorkflowRun } from '@k/shared'
import { db, projectsDb, workflowRunsDb } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
const projectId = uuid()
const workflowRunId = uuid()
const taskId = uuid()

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  // Wipe workflow_runs up front: the shared on-disk K_DATA_DIR persists across local
  // runs (the documented accumulation-flake class), and workflows-route.test.ts only
  // cleans its rows in afterAll — a row left by an aborted prior run would fail the
  // absolute empty-store assertion below. workflow_steps cascades (ON DELETE CASCADE),
  // so the blanket delete is safe. Mirrors c2-k-notes-schedule.test.ts's discipline.
  db.prepare('DELETE FROM workflow_runs').run()
})

afterAll(async () => {
  db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(workflowRunId)
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  await app.close()
})

describe('GET /api/workflows/runs', () => {
  it('401 without the Bearer header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/runs' })
    expect(res.statusCode).toBe(401)
  })

  it('empty store → 200 [] (the static /runs segment never falls into /:id → 404)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/runs', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('returns a seeded row mapped to the shared WorkflowRun shape (taskIds JSON → array)', async () => {
    const now = Date.now()
    projectsDb.insertProject.run({
      id: projectId, name: `c2-wf-runs-${projectId.slice(0, 8)}`, localPath: '/tmp/c2-wf-runs',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: now,
    })
    workflowRunsDb.insertWorkflowRun.run({
      id: workflowRunId, projectId, runId: null, taskIds: JSON.stringify([taskId]),
      mode: 'combined', status: 'running', createdAt: now, completedAt: null,
    })

    const res = await app.inject({ method: 'GET', url: '/api/workflows/runs', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as WorkflowRun[]
    const row = body.find(r => r.id === workflowRunId)
    expect(row).toMatchObject({
      id: workflowRunId,
      projectId,
      runId: null,
      taskIds: [taskId],
      mode: 'combined',
      status: 'running',
      completedAt: null,
    })
    expect(typeof row!.createdAt).toBe('number')
  })
})
