/**
 * Wave 3 — DELETE route tests for projects and tasks.
 *
 * Covers DELETE /api/projects/:id (404 / 409-active-run / 204 + full cascade) and
 * DELETE /api/projects/:id/tasks/:taskId (404 / 400-bad-uuid / 204). Builds the real
 * Fastify app in-process (buildApp) and drives it with app.inject. DB is isolated via
 * vitest.config.ts K_DATA_DIR; supervisor is mocked so no real process spawns.
 *
 * The cascade test is the important one: runs, events, verification_reports and
 * github_cache have NO ON DELETE CASCADE on projects, so db.deleteProject cleans them
 * transactionally — this proves nothing is left behind (and no FK error is thrown).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, projectsDb } from '../src/db.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

function makeProject(name: string): string {
  const id = uuid()
  projectsDb.insertProject.run({
    id,
    name: `${name}-${id.slice(0, 8)}`,
    localPath: '/tmp/delete-route-test',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  return id
}

function insertRun(projectId: string, status: string): string {
  const id = uuid()
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, status, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'p', '/tmp', status, projectId, Date.now())
  return id
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ── DELETE /api/projects/:id/tasks/:taskId ────────────────────────────────────

describe('DELETE /api/projects/:id/tasks/:taskId', () => {
  it('404 for unknown project', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${uuid()}/tasks/${uuid()}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('400 for a malformed taskId', async () => {
    const projectId = makeProject('task-del-badid')
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/tasks/not-a-uuid`, headers: AUTH })
    expect(res.statusCode).toBe(400)
  })

  it('404 for an unknown (well-formed) taskId', async () => {
    const projectId = makeProject('task-del-404')
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/tasks/${uuid()}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('404 when the taskId belongs to a DIFFERENT project (cross-project isolation)', async () => {
    const ownerId = makeProject('task-owner')
    const otherId = makeProject('task-other')
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${ownerId}/tasks`,
      headers: AUTH,
      payload: { title: 'belongs to owner' },
    })
    const taskId = created.json().id as string

    // Deleting via the wrong project must NOT remove the task.
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${otherId}/tasks/${taskId}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: `/api/projects/${ownerId}/tasks`, headers: AUTH })
    expect((list.json() as Array<{ id: string }>).some(t => t.id === taskId)).toBe(true)
  })

  it('204 + task gone from the list on success', async () => {
    const projectId = makeProject('task-del-ok')
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'doomed task' },
    })
    const taskId = created.json().id as string

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/tasks/${taskId}`, headers: AUTH })
    expect(del.statusCode).toBe(204)
    expect(del.body).toBe('')

    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/tasks`, headers: AUTH })
    expect((list.json() as Array<{ id: string }>).some(t => t.id === taskId)).toBe(false)
  })
})

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────

describe('DELETE /api/projects/:id', () => {
  it('404 for an unknown project', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${uuid()}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('409 while the project has an active run, then 204 once it is no longer active', async () => {
    const projectId = makeProject('proj-del-active')
    const runId = insertRun(projectId, 'running')

    const blocked = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: AUTH })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toMatch(/active run/i)

    // Finish the run → no longer active → delete succeeds.
    db.prepare(`UPDATE runs SET status = 'done' WHERE id = ?`).run(runId)
    const ok = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: AUTH })
    expect(ok.statusCode).toBe(204)
    expect(projectsDb.getProject.get(projectId)).toBeUndefined()
  })

  it('409 while an interactive run is parked at awaiting_input (still live)', async () => {
    const projectId = makeProject('proj-del-awaiting')
    // An interactive run parked on stdin holds a worktree + writes events — deleting
    // its project would corrupt state, so the delete route must refuse.
    insertRun(projectId, 'awaiting_input')

    const blocked = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: AUTH })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toMatch(/active run/i)
  })

  it('204 + cascades every dependent (tasks, runs, events, reports, graph, github cache)', async () => {
    const projectId = makeProject('proj-del-cascade')

    // A task (cascades via FK)
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'cascade task' },
    })
    // A finished run + one event (no cascade — cleaned explicitly)
    const runId = insertRun(projectId, 'done')
    db.prepare(`INSERT INTO events (id, run_id, seq, type, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(uuid(), runId, 0, 'message', Date.now())
    // A verification report (no cascade)
    db.prepare(
      `INSERT INTO verification_reports (id, project_id, score, started_at) VALUES (?, ?, ?, ?)`,
    ).run(uuid(), projectId, 80, Date.now())
    // A github_cache row (no FK at all)
    db.prepare(
      `INSERT INTO github_cache (project_id, kind, payload, fetched_at) VALUES (?, 'pr', '[]', ?)`,
    ).run(projectId, Date.now())
    // A project_graphs row (cascades via FK)
    db.prepare(
      `INSERT INTO project_graphs (project_id, status, updated_at) VALUES (?, 'ready', ?)`,
    ).run(projectId, Date.now())

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: AUTH })
    expect(del.statusCode).toBe(204)

    const count = (sql: string) => (db.prepare(sql).get(projectId) as { n: number }).n
    expect(projectsDb.getProject.get(projectId)).toBeUndefined()
    expect(count(`SELECT COUNT(*) AS n FROM project_tasks WHERE project_id = ?`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM runs WHERE project_id = ?`)).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM verification_reports WHERE project_id = ?`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM github_cache WHERE project_id = ?`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM project_graphs WHERE project_id = ?`)).toBe(0)
  })
})
