/**
 * Wave 2 — task-workflow dispatch route.
 *
 * POST /api/projects/:id/tasks/dispatch launches ONE supervised delegation run
 * over a batch of selected todos via dispatchTaskWorkflow (workflows.ts). The
 * supervisor is mocked (vi.mock, hoisted) so no real claude subprocess spawns.
 * Mirrors graph-dispatch.test.ts's standalone-Fastify harness.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db, projectsDb, projectTasksDb } from '../src/db.js'
import { projectsRoutes } from '../src/routes/projects.js'
import type { Project } from '@k/shared'

// Hoisted mock — workflows.ts imports startRun from here, so a 202 dispatch
// never launches a real process. eventBus stays real; the run never terminates
// during the test, so finalize doesn't fire. The mock MUST insert a real `runs`
// row: workflow_runs.run_id has a FOREIGN KEY → runs(id) that the dispatch path
// patches (workflows.ts step 5).
vi.mock('../src/supervisor.js', async () => {
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    startRun: vi.fn(async () => {
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES ('mock-run', 'wf', '.', 'queued', ?)`,
      ).run(Date.now())
      return { id: 'mock-run', status: 'queued' }
    }),
  }
})
import { startRun } from '../src/supervisor.js'
const startRunMock = vi.mocked(startRun)

const tmpDirs: string[] = []
const projectIds: string[] = []

function insertProject(): Project {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-wf-dispatch-'))
  tmpDirs.push(d)
  const project: Project = {
    id: uuid(),
    name: `wf-dispatch-test-${uuid().slice(0, 8)}`,
    localPath: d,
    githubRemote: undefined,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
  projectsDb.insertProject.run({
    id: project.id, name: project.name, localPath: project.localPath,
    githubRemote: null, workspaceManaged: 0, bibleDir: project.bibleDir, createdAt: project.createdAt,
  })
  projectIds.push(project.id)
  return project
}

function insertTask(projectId: string, title = 'todo'): string {
  const id = uuid()
  projectTasksDb.insertProjectTask.run({
    id,
    projectId,
    title,
    status: 'open',
    createdAt: Date.now(),
    completedAt: null,
    issueNumber: null,
    issueUrl: null,
    issueState: null,
  })
  return id
}

function taskStatus(taskId: string, projectId: string): string | undefined {
  const row = projectTasksDb.getProjectTask.get(taskId, projectId) as { status?: string } | undefined
  return row?.status
}

afterAll(() => {
  for (const id of projectIds) {
    db.prepare('DELETE FROM workflow_runs WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
  try { db.prepare(`DELETE FROM runs WHERE id = 'mock-run'`).run() } catch { /* ignore */ }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

// NIT: this harness registers projectsRoutes on a bare Fastify instance without
// auth middleware. Auth is enforced at the buildApp layer and is deliberately
// omitted here so these tests exercise route behavior in isolation.
describe('POST /api/projects/:id/tasks/dispatch', () => {
  beforeEach(() => startRunMock.mockClear())

  it('404 when the project is unknown', async () => {
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${uuid()}/tasks/dispatch`,
        payload: { taskIds: [uuid()] },
      })
      expect(res.statusCode).toBe(404)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('400 on empty taskIds (schema .min(1))', async () => {
    const project = insertProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds: [] },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBeTruthy()
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('400 on a non-uuid taskId (schema)', async () => {
    const project = insertProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds: ['not-a-uuid'] },
      })
      expect(res.statusCode).toBe(400)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('400 when a well-formed uuid is not a real task in the project', async () => {
    const project = insertProject()
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds: [uuid()] },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('task not found')
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('202 + { workflowRunId, runId } and locks selected tasks to in_progress', async () => {
    const project = insertProject()
    const t1 = insertTask(project.id, 'first todo')
    const t2 = insertTask(project.id, 'second todo')
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds: [t1, t2] },
      })
      expect(res.statusCode).toBe(202)
      const body = res.json()
      expect(typeof body.workflowRunId).toBe('string')
      expect(body.runId).toBe('mock-run')
      expect(startRunMock).toHaveBeenCalledTimes(1)
      const [, opts] = startRunMock.mock.calls[0]
      expect(opts).toMatchObject({ cwd: project.localPath, projectId: project.id })
      // The selected tasks are now in_progress in the DB.
      expect(taskStatus(t1, project.id)).toBe('in_progress')
      expect(taskStatus(t2, project.id)).toBe('in_progress')
    } finally {
      await app.close()
    }
  })

  it('500 + { error: "dispatch failed" } and reverts the task to open when startRun fails with a non-task error', async () => {
    const project = insertProject()
    const t1 = insertTask(project.id, 'will revert')
    // Non-TaskNotFound error → 500 degrade path (workflows.ts reverts the lock).
    startRunMock.mockRejectedValueOnce(new Error('EACCES permission denied'))
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds: [t1] },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'dispatch failed' })
      expect(startRunMock).toHaveBeenCalledTimes(1)
      // The degrade path reverted the task back to 'open'.
      expect(taskStatus(t1, project.id)).toBe('open')
    } finally {
      await app.close()
    }
  })

  it('400 on more than 50 taskIds (schema .max(50))', async () => {
    const project = insertProject()
    const taskIds = Array.from({ length: 51 }, () => uuid())
    const app = Fastify()
    await app.register(projectsRoutes)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks/dispatch`,
        payload: { taskIds },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBeTruthy()
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
