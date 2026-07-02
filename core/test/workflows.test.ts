/**
 * Workflows tests — pure prompt-builder + dispatchTaskWorkflow lifecycle.
 *
 * Same pattern as skill-eval.test.ts: supervisor.startRun mocked so no real
 * process spawns (but it inserts a real runs row — workflow_runs.run_id has a
 * FOREIGN KEY → runs(id)). Isolated DB via vitest.config.ts K_DATA_DIR. Pure
 * helpers are imported directly and unit-tested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, projectTasksDb, workflowRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import type { Project, ProjectTask, Run } from '@k/shared'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real
// runs row: workflow_runs.run_id has a FOREIGN KEY → runs(id).
import { vi } from 'vitest'
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-wf-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'wf', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { buildDelegationPrompt, deriveWorkflowStatus, finalizeWorkflowRun, dispatchTaskWorkflow } =
  await import('../src/workflows.js')

function makeTask(title: string): ProjectTask {
  return {
    id: uuid(),
    projectId: uuid(),
    title,
    status: 'open',
    createdAt: 0,
    completedAt: null,
  }
}

describe('buildDelegationPrompt', () => {
  it('single task — contains the title, the loop instruction, and the no-push guard', () => {
    const prompt = buildDelegationPrompt([makeTask('Fix the login bug')])
    expect(prompt).toContain('Fix the login bug')
    expect(prompt).toContain('implementer → spec-review → quality-review')
    expect(prompt).toContain('NEVER push to a default branch')
    expect(prompt).toContain('ONE reviewable commit')
    // reports progress through the kstore status-write tools (Wave 7)
    expect(prompt).toContain('workflow_step_set')
    expect(prompt).toContain('workflow_status_set')
  })

  it('multiple tasks — every title appears in a numbered checklist', () => {
    const titles = ['Add dark mode', 'Refactor auth', 'Write docs']
    const prompt = buildDelegationPrompt(titles.map(makeTask))
    for (const t of titles) expect(prompt).toContain(t)
    expect(prompt).toContain('1. [ ] Add dark mode')
    expect(prompt).toContain('3. [ ] Write docs')
  })

  it('empty array — throws (explicit contract guard)', () => {
    expect(() => buildDelegationPrompt([])).toThrow(/at least one task/)
  })
})

describe('deriveWorkflowStatus', () => {
  it('done → completed; any other terminal → failed', () => {
    expect(deriveWorkflowStatus('done')).toBe('completed')
    expect(deriveWorkflowStatus('error')).toBe('failed')
    expect(deriveWorkflowStatus('killed')).toBe('failed')
    expect(deriveWorkflowStatus('interrupted')).toBe('failed')
  })
})

describe('dispatchTaskWorkflow', () => {
  const projectId = uuid()
  const project: Project = {
    id: projectId,
    name: `wf-test-${projectId.slice(0, 8)}`,
    localPath: '.',
    workspaceManaged: false,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
  const taskA = uuid()
  const taskB = uuid()
  const taskC = uuid()

  beforeAll(() => {
    projectsDb.insertProject.run({
      id: project.id,
      name: project.name,
      localPath: project.localPath,
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: project.bibleDir,
      createdAt: project.createdAt,
    })
    for (const [id, title] of [[taskA, 'Task A'], [taskB, 'Task B'], [taskC, 'Task C']] as const) {
      projectTasksDb.insertProjectTask.run({
        id, projectId: project.id, title, status: 'open', createdAt: Date.now(),
        completedAt: null, issueNumber: null, issueUrl: null, issueState: null,
      })
    }
  })

  afterAll(() => {
    db.prepare('DELETE FROM workflow_runs WHERE project_id = ?').run(project.id)
    db.prepare('DELETE FROM work_items WHERE project_id = ?').run(project.id)
    db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-wf-run-%'`).run()
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
  })

  it('throws when any task id is missing / not in this project', async () => {
    await expect(dispatchTaskWorkflow(project, [taskA, uuid()])).rejects.toThrow(/Task not found/)
  })

  it('locks selected tasks in_progress, inserts a running workflow_run, finalizes on terminal run_update', async () => {
    const { workflowRunId, runId } = await dispatchTaskWorkflow(project, [taskA, taskB])
    expect(typeof workflowRunId).toBe('string')
    expect(runId).toMatch(/^mock-wf-run-/)

    // Tasks locked to in_progress (NOT done).
    for (const id of [taskA, taskB]) {
      const t = db.prepare('SELECT status FROM work_items WHERE id = ?').get(id) as { status: string }
      expect(t.status).toBe('in_progress')
    }

    // workflow_run inserted, running, runId patched, taskIds JSON persisted.
    const wf = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(workflowRunId) as Record<string, unknown>
    expect(wf.status).toBe('running')
    expect(wf.run_id).toBe(runId)
    expect(wf.mode).toBe('combined')
    expect(JSON.parse(String(wf.task_ids))).toEqual([taskA, taskB])

    // Drive the live finalize path: emit a terminal run_update.
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const after = db.prepare('SELECT status, completed_at FROM workflow_runs WHERE id = ?').get(workflowRunId) as { status: string; completed_at: number | null }
    expect(after.status).toBe('completed')
    expect(after.completed_at).not.toBeNull()
  })

  it('finalizeWorkflowRun maps a failed terminal status to failed', () => {
    const wfId = uuid()
    db.prepare(
      `INSERT INTO workflow_runs (id, project_id, run_id, task_ids, mode, status, created_at, completed_at)
       VALUES (?, ?, NULL, '[]', 'combined', 'running', ?, NULL)`,
    ).run(wfId, project.id, Date.now())
    finalizeWorkflowRun(wfId, 'error')
    const row = db.prepare('SELECT status, completed_at FROM workflow_runs WHERE id = ?').get(wfId) as { status: string; completed_at: number | null }
    expect(row.status).toBe('failed')
    expect(row.completed_at).not.toBeNull()
  })

  it('startRun throws — re-throws, marks workflow_run failed, reverts task to open', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(dispatchTaskWorkflow(project, [taskC])).rejects.toThrow(/spawn failed/)

    // No workflow_run row for this project is left 'running'.
    const rows = workflowRunsDb.listWorkflowRunsByProject.all(project.id) as { status: string }[]
    expect(rows.some(r => r.status === 'running')).toBe(false)
    // The dispatch's row was finalized 'failed'.
    expect(rows.some(r => r.status === 'failed')).toBe(true)

    // The selected task is reverted to 'open' (not left in_progress).
    const t = db.prepare('SELECT status FROM work_items WHERE id = ?').get(taskC) as { status: string }
    expect(t.status).toBe('open')
  })
})
