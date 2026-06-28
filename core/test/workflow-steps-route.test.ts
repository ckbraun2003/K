/**
 * Wave 7 — GET /api/runs/:id/workflow-steps.
 *
 * The explicit progress checklist the orchestrator reports via the kstore
 * status-write tools, resolved through the run's workflow_run. Bare-Fastify
 * harness (no auth layer), mirroring workflows-route.test.ts. No supervisor
 * spawn — we seed rows directly.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, runsDb, workflowRunsDb } from '../src/db.js'
import { runsRoutes } from '../src/routes/runs.js'

const PROJECT_ID = uuid()
const RUN_WF = uuid()
const RUN_PLAIN = uuid()
const WF_ID = uuid()

function seedRun(id: string) {
  runsDb.insertRun.run({
    id, prompt: 'wf-steps fixture', cwd: '/tmp/wf', worktree: null, status: 'running',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
}

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `wf-steps-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/wf',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  seedRun(RUN_WF)
  seedRun(RUN_PLAIN)
  workflowRunsDb.insertWorkflowRun.run({
    id: WF_ID, projectId: PROJECT_ID, runId: RUN_WF, taskIds: '[]', mode: 'combined',
    status: 'running', createdAt: Date.now(), completedAt: null,
  })
  // Seed two steps with explicit seq in REVERSE insertion order (CI=2 inserted
  // before Implement X=1) so the route's ORDER BY seq is actually exercised — an
  // insertion-order return would fail the ['Implement X','CI'] assertion.
  const insertStep = db.prepare(
    `INSERT INTO workflow_steps (id, workflow_run_id, seq, label, kind, work_item_id, status, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertStep.run(uuid(), WF_ID, 2, 'CI', 'ci', null, 'pending', 'awaiting PR', Date.now())
  insertStep.run(uuid(), WF_ID, 1, 'Implement X', 'task', null, 'in_progress', null, Date.now())
})

afterAll(() => {
  db.prepare('DELETE FROM workflow_steps WHERE workflow_run_id = ?').run(WF_ID)
  db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(WF_ID)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_WF, RUN_PLAIN)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('GET /api/runs/:id/workflow-steps', () => {
  it('returns the workflow_run + its steps ordered by seq, mapped to camelCase', async () => {
    const app = Fastify()
    await app.register(runsRoutes)
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${RUN_WF}/workflow-steps` })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.workflowRun.id).toBe(WF_ID)
      expect(body.workflowRun.status).toBe('running')
      expect(body.steps.map((s: { label: string }) => s.label)).toEqual(['Implement X', 'CI'])
      const ci = body.steps[1]
      expect(ci.kind).toBe('ci')
      expect(ci.status).toBe('pending')
      expect(ci.detail).toBe('awaiting PR')
      expect(ci.workItemId).toBeNull()
      expect(typeof ci.workflowRunId).toBe('string')
    } finally {
      await app.close()
    }
  })

  it('returns { workflowRun: null, steps: [] } for a run that is not a workflow', async () => {
    const app = Fastify()
    await app.register(runsRoutes)
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${RUN_PLAIN}/workflow-steps` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ workflowRun: null, steps: [] })
    } finally {
      await app.close()
    }
  })

  it('returns the empty shape for an entirely unknown run id', async () => {
    const app = Fastify()
    await app.register(runsRoutes)
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${uuid()}/workflow-steps` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ workflowRun: null, steps: [] })
    } finally {
      await app.close()
    }
  })
})
