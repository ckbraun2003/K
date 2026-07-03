/**
 * Wave 3-7 — syncIssues: GitHub issue → project_tasks reconciliation.
 *
 * Drives syncIssues with an INJECTED fetcher (no live `gh` CLI). Covers insert,
 * update/no-clobber, reopen, close, and the degradation contract. DB is isolated
 * to os.tmpdir() via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { IssueInfo, Project } from '@k/shared'
import { syncIssues } from '../src/github.js'
import { projectsDb, projectWorkItemsDb, db } from '../src/db.js'

const projectIds: string[] = []

function makeProject(githubRemote: string | null = 'owner/repo'): Project {
  const id = uuid()
  projectsDb.insertProject.run({
    id,
    name: `gh-issues-${id.slice(0, 8)}`,
    localPath: '/tmp/gh-issues',
    githubRemote,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  projectIds.push(id)
  return {
    id,
    name: `gh-issues-${id.slice(0, 8)}`,
    localPath: '/tmp/gh-issues',
    githubRemote: githubRemote ?? undefined,
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
}

function tasksFor(projectId: string): Array<Record<string, unknown>> {
  return projectWorkItemsDb.listProjectTasks.all(projectId) as Array<Record<string, unknown>>
}

const fetcher = (issues: IssueInfo[]) => async () => issues

afterAll(() => {
  for (const id of projectIds) {
    try { db.prepare('DELETE FROM work_items WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
})

describe('syncIssues', () => {
  let project: Project

  beforeEach(() => {
    project = makeProject()
  })

  it('insert: creates tasks with correct status mapping + issue fields', async () => {
    const issues: IssueInfo[] = [
      { number: 1, title: 'Open one', state: 'OPEN', url: 'https://github.com/o/r/issues/1' },
      { number: 2, title: 'Closed one', state: 'CLOSED', url: 'https://github.com/o/r/issues/2' },
    ]
    const res = await syncIssues(project, fetcher(issues))
    expect(res).toEqual({ synced: 2, degraded: false })

    const tasks = tasksFor(project.id)
    expect(tasks).toHaveLength(2)
    const open = tasks.find(t => t.issue_number === 1)!
    const closed = tasks.find(t => t.issue_number === 2)!
    expect(open.status).toBe('open')
    expect(open.title).toBe('Open one')
    expect(open.issue_url).toBe('https://github.com/o/r/issues/1')
    expect(open.issue_state).toBe('OPEN')
    expect(open.completed_at).toBeNull()
    expect(closed.status).toBe('done')
    expect(typeof closed.completed_at).toBe('number')
  })

  it('update / no-clobber: open issue does not overwrite in_progress', async () => {
    // pre-seed a task linked to issue #10 with status in_progress
    const taskId = uuid()
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId,
      projectId: project.id,
      title: 'old title',
      status: 'in_progress',
      createdAt: Date.now(),
      completedAt: null,
      issueNumber: 10,
      issueUrl: 'old-url',
      issueState: 'OPEN',
    })
    const res = await syncIssues(project, fetcher([
      { number: 10, title: 'new title', state: 'OPEN', url: 'new-url' },
    ]))
    expect(res).toEqual({ synced: 1, degraded: false })
    const tasks = tasksFor(project.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('in_progress') // not clobbered
    expect(tasks[0].title).toBe('new title')    // refreshed
    expect(tasks[0].issue_url).toBe('new-url')
    expect(tasks[0].completed_at).toBeNull()
  })

  it('reopen: done task with a now-open issue returns to open', async () => {
    const taskId = uuid()
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId,
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

  it('close: open task with a now-closed issue becomes done', async () => {
    const taskId = uuid()
    projectWorkItemsDb.insertProjectTask.run({
      id: taskId,
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

  it('degradation: a throwing fetcher returns degraded with no writes', async () => {
    const res = await syncIssues(project, async () => { throw new Error('gh not found') })
    expect(res).toEqual({ synced: 0, degraded: true })
    expect(tasksFor(project.id)).toHaveLength(0)
  })

  it('degradation: project without a remote returns degraded (fetcher never runs)', async () => {
    const noRemote = makeProject(null)
    let called = false
    const res = await syncIssues(noRemote, async () => { called = true; return [] })
    expect(res).toEqual({ synced: 0, degraded: true })
    expect(called).toBe(false)
  })
})
