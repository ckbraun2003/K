/**
 * P5.1d — characterization tests (the D-026 unification down-payment).
 *
 * Pins the CURRENT, INVARIANT contract of BOTH task stores + GitHub issue-sync,
 * so the P5.1d1 additive `scope` column can be proven not to change any existing
 * behavior. Every assertion here holds identically BEFORE and AFTER the change:
 *   - kstore work_item lifecycle + run-scope isolation (invariants only — this
 *     file deliberately does NOT assert on `scope`; that lives in the sibling
 *     p5-1d-work-item-scope.test.ts feature file).
 *   - project_tasks repo/route (POST/PATCH/GET, 404s, completedAt rules).
 *   - syncIssues mapping with an INJECTED fetcher (insert/close/reopen/degrade).
 *
 * Modeled on kstore.test.ts, tasks-route.test.ts, and github-issues.test.ts:
 * real DB singleton, unique-id fixtures, cleanup in afterAll. Supervisor is
 * mocked (like tasks-route.test.ts) so buildApp() never spawns a real process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import type { IssueInfo, Project, WorkItem } from '@k/shared'
import { db, runsDb, projectsDb, projectTasksDb } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import { syncIssues } from '../src/github.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

// ── kstore work_item lifecycle — INVARIANTS ONLY (no `scope`) ─────────────────

describe('P5.1d char: kstore work_item lifecycle + run-scope isolation', () => {
  const PROJECT_ID = uuid()
  const RUN_A = uuid()
  const RUN_B = uuid()
  const createdWorkItemIds: string[] = []

  const ctxA: KStoreContext = { runId: RUN_A }
  const ctxB: KStoreContext = { runId: RUN_B }

  function call(name: string, args: unknown, ctx: KStoreContext): unknown {
    const tool = kStoreTools.find(t => t.name === name)
    if (!tool) throw new Error(`no such kstore tool: ${name}`)
    return tool.handler(args, ctx)
  }

  beforeAll(() => {
    projectsDb.insertProject.run({
      id: PROJECT_ID,
      name: `p51d-char-${PROJECT_ID.slice(0, 8)}`,
      localPath: '/tmp/p51d-char',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    for (const id of [RUN_A, RUN_B]) {
      runsDb.insertRun.run({
        id,
        prompt: 'p51d char fixture',
        cwd: '/tmp/p51d-char',
        worktree: null,
        status: 'running',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        projectId: PROJECT_ID,
        createdAt: Date.now(),
      })
    }
  })

  afterAll(() => {
    for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
  })

  it('create returns { status: open, runId = owner, title }', () => {
    const item = call('work_item_create', { title: 'Do the thing', body: 'details' }, ctxA) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.title).toBe('Do the thing')
    expect(item.status).toBe('open')
    expect(item.runId).toBe(RUN_A)
    expect(item.body).toBe('details')
    expect(item.createdAt).toBeGreaterThan(0)
    expect(item.updatedAt).toBeGreaterThan(0)
  })

  it('list-by-status finds a created item; update flips its status', () => {
    const created = call('work_item_create', { title: 'list + update me' }, ctxA) as WorkItem
    createdWorkItemIds.push(created.id)

    const open = call('work_item_list', { status: 'open' }, ctxA) as WorkItem[]
    expect(open.some(w => w.id === created.id)).toBe(true)

    const updated = call('work_item_update', { id: created.id, status: 'done' }, ctxA) as WorkItem
    expect(updated.status).toBe('done')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    const stillOpen = call('work_item_list', { status: 'open' }, ctxA) as WorkItem[]
    expect(stillOpen.some(w => w.id === created.id)).toBe(false)
  })

  it('update rejects an empty patch and an unknown id (KStoreError)', () => {
    const real = call('work_item_create', { title: 'guard' }, ctxA) as WorkItem
    createdWorkItemIds.push(real.id)
    expect(() => call('work_item_update', { id: real.id }, ctxA)).toThrow(KStoreError)
    expect(() => call('work_item_update', { id: uuid(), status: 'done' }, ctxA)).toThrow(KStoreError)
  })

  it('run-scope isolation: one run cannot list or update another run\'s item', () => {
    const mine = call('work_item_create', { title: 'A-owned ticket' }, ctxA) as WorkItem
    createdWorkItemIds.push(mine.id)
    const bList = call('work_item_list', {}, ctxB) as WorkItem[]
    expect(bList.some(w => w.id === mine.id)).toBe(false)
    expect(() => call('work_item_update', { id: mine.id, status: 'done' }, ctxB)).toThrow(KStoreError)
    // the owner still can
    const owned = call('work_item_update', { id: mine.id, status: 'in_progress' }, ctxA) as WorkItem
    expect(owned.status).toBe('in_progress')
  })
})

// ── project_tasks repo/route (via buildApp + app.inject) ──────────────────────

describe('P5.1d char: project_tasks route', () => {
  const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
  const AUTH = { authorization: `Bearer ${TOKEN}` }
  let app: FastifyInstance
  let projectId: string

  beforeAll(async () => {
    process.env.K_SKIP_BOOTSTRAP = '1'
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()

    projectId = uuid()
    projectsDb.insertProject.run({
      id: projectId,
      name: `p51d-char-route-${projectId.slice(0, 8)}`,
      localPath: '/tmp/p51d-char-route',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
  })

  afterAll(async () => {
    try { db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(projectId) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) } catch { /* ignore */ }
    await app.close()
  })

  it('POST creates a task with status open + completedAt null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'A characterized task' },
    })
    expect(res.statusCode).toBe(201)
    const task = res.json()
    expect(task).toMatchObject({ title: 'A characterized task', status: 'open', projectId })
    expect(task.completedAt).toBeNull()
    expect(typeof task.id).toBe('string')
    expect(typeof task.createdAt).toBe('number')
  })

  it('PATCH open/in_progress/done sets completedAt correctly', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: AUTH,
      payload: { title: 'patch me' },
    })
    const taskId = created.json().id as string

    const inProg = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'in_progress' },
    })
    expect(inProg.statusCode).toBe(200)
    expect(inProg.json().status).toBe('in_progress')
    expect(inProg.json().completedAt).toBeNull()

    const before = Date.now()
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'done' },
    })
    expect(done.statusCode).toBe(200)
    expect(done.json().status).toBe('done')
    expect(typeof done.json().completedAt).toBe('number')
    expect(done.json().completedAt).toBeGreaterThanOrEqual(before)

    const reopened = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${taskId}`,
      headers: AUTH,
      payload: { status: 'open' },
    })
    expect(reopened.statusCode).toBe(200)
    expect(reopened.json().status).toBe('open')
    expect(reopened.json().completedAt).toBeNull()
  })

  it('404 for an unknown project (GET) and an unknown task (PATCH)', async () => {
    const unknownProject = await app.inject({
      method: 'GET',
      url: `/api/projects/${uuid()}/tasks`,
      headers: AUTH,
    })
    expect(unknownProject.statusCode).toBe(404)
    expect(unknownProject.json().error).toBeTruthy()

    const unknownTask = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/tasks/${uuid()}`,
      headers: AUTH,
      payload: { status: 'in_progress' },
    })
    expect(unknownTask.statusCode).toBe(404)
    expect(unknownTask.json().error).toBeTruthy()
  })
})

// ── syncIssues mapping (INJECTED fetcher, no live gh) ─────────────────────────

describe('P5.1d char: syncIssues mapping', () => {
  const projectIds: string[] = []

  function makeProject(githubRemote: string | null = 'owner/repo'): Project {
    const id = uuid()
    projectsDb.insertProject.run({
      id,
      name: `p51d-char-gh-${id.slice(0, 8)}`,
      localPath: '/tmp/p51d-char-gh',
      githubRemote,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    projectIds.push(id)
    return {
      id,
      name: `p51d-char-gh-${id.slice(0, 8)}`,
      localPath: '/tmp/p51d-char-gh',
      githubRemote: githubRemote ?? undefined,
      workspaceManaged: false,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    }
  }

  function tasksFor(projectId: string): Array<Record<string, unknown>> {
    return projectTasksDb.listProjectTasks.all(projectId) as Array<Record<string, unknown>>
  }

  const fetcher = (issues: IssueInfo[]) => async () => issues

  let project: Project
  beforeEach(() => {
    project = makeProject()
  })

  afterAll(() => {
    for (const id of projectIds) {
      try { db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(id) } catch { /* ignore */ }
      try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
    }
  })

  it('new open issue → insert task open; new closed issue → done + completedAt', async () => {
    const res = await syncIssues(project, fetcher([
      { number: 1, title: 'Open one', state: 'OPEN', url: 'https://github.com/o/r/issues/1' },
      { number: 2, title: 'Closed one', state: 'CLOSED', url: 'https://github.com/o/r/issues/2' },
    ]))
    expect(res).toEqual({ synced: 2, degraded: false })
    const tasks = tasksFor(project.id)
    const open = tasks.find(t => t.issue_number === 1)!
    const closed = tasks.find(t => t.issue_number === 2)!
    expect(open.status).toBe('open')
    expect(open.completed_at).toBeNull()
    expect(closed.status).toBe('done')
    expect(typeof closed.completed_at).toBe('number')
  })

  it('existing open task with a now-closed issue → done', async () => {
    projectTasksDb.insertProjectTask.run({
      id: uuid(),
      projectId: project.id,
      title: 't',
      status: 'open',
      createdAt: Date.now(),
      completedAt: null,
      issueNumber: 12,
      issueUrl: 'u',
      issueState: 'OPEN',
    })
    await syncIssues(project, fetcher([{ number: 12, title: 't', state: 'CLOSED', url: 'u' }]))
    const tasks = tasksFor(project.id)
    expect(tasks[0].status).toBe('done')
    expect(typeof tasks[0].completed_at).toBe('number')
  })

  it('existing done task with a now-open issue → reopened to open', async () => {
    projectTasksDb.insertProjectTask.run({
      id: uuid(),
      projectId: project.id,
      title: 't',
      status: 'done',
      createdAt: Date.now(),
      completedAt: Date.now(),
      issueNumber: 11,
      issueUrl: 'u',
      issueState: 'CLOSED',
    })
    await syncIssues(project, fetcher([{ number: 11, title: 't', state: 'OPEN', url: 'u' }]))
    const tasks = tasksFor(project.id)
    expect(tasks[0].status).toBe('open')
    expect(tasks[0].completed_at).toBeNull()
  })

  it('a project with no githubRemote → { synced: 0, degraded: true }, fetcher never runs', async () => {
    const noRemote = makeProject(null)
    let called = false
    const res = await syncIssues(noRemote, async () => { called = true; return [] })
    expect(res).toEqual({ synced: 0, degraded: true })
    expect(called).toBe(false)
  })
})
