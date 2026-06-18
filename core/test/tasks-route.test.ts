/**
 * G-6 — Project task CRUD route tests.
 *
 * Covers GET/POST /api/projects/:id/tasks and PATCH /api/projects/:id/tasks/:taskId.
 * Builds the real Fastify app in-process (buildApp from index.ts) and drives it
 * with app.inject — no socket, no poller. DB is isolated via vitest.config.ts K_DATA_DIR.
 *
 * Bootstrap is skipped via K_SKIP_BOOTSTRAP (set before importing index) so the
 * top-level listen()/poller never runs. Supervisor is mocked so startRun never
 * spawns a real process.
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
let projectId: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  // Insert a test project directly so we have a known project ID
  projectId = uuid()
  projectsDb.insertProject.run({
    id: projectId,
    name: `tasks-route-test-${projectId.slice(0, 8)}`,
    localPath: '/tmp/tasks-route-test',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
})

afterAll(async () => {
  // Clean up tasks and project
  try { db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(projectId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) } catch { /* ignore */ }
  await app.close()
})

// ── GET /api/projects/:id/tasks ───────────────────────────────────────────────

describe('GET /api/projects/:id/tasks', () => {
  it('404 for unknown project', async () => {
    const unknownId = uuid()
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${unknownId}/tasks`,
      headers: AUTH,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBeTruthy()
  })

  it('200 + empty array for known project with no tasks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(0)
  })
})

// ── POST /api/projects/:id/tasks ──────────────────────────────────────────────

describe('POST /api/projects/:id/tasks', () => {
  it('400 if title missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('400 if title is empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 if title is too long (>1000 chars)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'a'.repeat(1001) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('201 + task shape on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'My first task' },
    })
    expect(res.statusCode).toBe(201)
    const task = res.json()
    expect(task).toMatchObject({
      title: 'My first task',
      status: 'open',
      projectId,
    })
    expect(typeof task.id).toBe('string')
    expect(typeof task.createdAt).toBe('number')
    // completedAt is null when open
    expect(task.completedAt).toBeNull()
  })

  it('created task appears in GET list', async () => {
    const title = `task-appears-in-list-${Date.now()}`
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title },
    })
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
    })
    expect(listRes.statusCode).toBe(200)
    const tasks = listRes.json() as Array<{ title: string }>
    expect(tasks.some(t => t.title === title)).toBe(true)
  })
})

// ── PATCH /api/projects/:id/tasks/:taskId ─────────────────────────────────────

describe('PATCH /api/projects/:id/tasks/:taskId', () => {
  // Create a task to patch for these tests
  let taskId: string

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'Patchable task' },
    })
    taskId = res.json().id as string
  })

  it('400 for invalid status value', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'invalid-status' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 for missing status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 for unknown task', async () => {
    const unknownTaskId = uuid()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${unknownTaskId}`,
      headers: AUTH,
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBeTruthy()
  })

  it('200 + updated status on success', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('in_progress')
  })

  it('completedAt set when status → done', async () => {
    const before = Date.now()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'done' },
    })
    expect(res.statusCode).toBe(200)
    const task = res.json()
    expect(task.status).toBe('done')
    expect(typeof task.completedAt).toBe('number')
    expect(task.completedAt).toBeGreaterThanOrEqual(before)
  })

  it('completedAt null when status → open (re-opening)', async () => {
    // Move to done first
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'done' },
    })
    // Now re-open
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'open' },
    })
    expect(res.statusCode).toBe(200)
    const task = res.json()
    expect(task.status).toBe('open')
    expect(task.completedAt).toBeNull()
  })

  it('completedAt null when status is in_progress', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().completedAt).toBeNull()
  })
})

// ── completedAt invariants for new tasks ─────────────────────────────────────

describe('completedAt is null for freshly created tasks', () => {
  it('new task with status open has completedAt: null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'Fresh open task' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().completedAt).toBeNull()
    expect(res.json().status).toBe('open')
  })
})
