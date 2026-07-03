/**
 * Campaign S4 — dispatchTaskWorkflow validate-before-mutate (LOCK suite).
 *
 * The S4 lock-hygiene angle (S2 already covered the done→open degrade fault and
 * the lifecycle/finalize/steps): when a multi-task dispatch names a MISSING task,
 * dispatchTaskWorkflow must validate ALL task ids in step 1 BEFORE it locks any
 * task or inserts a workflow_run row — so a bad id leaves NOTHING locked and NO
 * orphaned workflow_run. This pins that atomic-validate contract (the safe
 * counterpart to the empty-array fault S4-018).
 *
 * startRun is mocked so no real agent spawns (mirrors workflows.test.ts); it must
 * NOT be reached on the validation-failure path.
 *
 * Findings: S4-017. See testing/findings/S4-prompt-delegation.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, projectWorkItemsDb, workflowRunsDb } from '../src/db.js'
import { startRun } from '../src/supervisor.js'
import type { Project } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-s4-lh-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'wf', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { dispatchTaskWorkflow } = await import('../src/workflows.js')

const PROJECT_ID = uuid()
const project: Project = {
  id: PROJECT_ID, name: `s4-lh-${PROJECT_ID.slice(0, 8)}`, localPath: '.',
  workspaceManaged: false, bibleDir: 'docs/bible', createdAt: Date.now(),
}
const OPEN_TASK = uuid()

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: project.name, localPath: project.localPath,
    githubRemote: null, workspaceManaged: 0, bibleDir: project.bibleDir, createdAt: project.createdAt,
  })
  projectWorkItemsDb.insertProjectTask.run({
    id: OPEN_TASK, projectId: PROJECT_ID, title: 'ready to ship', status: 'open',
    createdAt: Date.now(), completedAt: null, issueNumber: null, issueUrl: null, issueState: null,
  })
})

afterAll(() => {
  db.prepare('DELETE FROM workflow_runs WHERE project_id = ?').run(PROJECT_ID)
  db.prepare('DELETE FROM work_items WHERE project_id = ?').run(PROJECT_ID)
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-s4-lh-run-%'`).run()
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S4 dispatchTaskWorkflow: a missing task in a batch locks nothing', () => {
  it('S4-017: [valid, missing] throws TaskNotFoundError, leaves the valid task open + inserts no workflow_run', async () => {
    const before = workflowRunsDb.listWorkflowRunsByProject.all(PROJECT_ID) as unknown[]
    const missing = uuid()

    await expect(dispatchTaskWorkflow(project, [OPEN_TASK, missing])).rejects.toThrow(/Task not found/)

    // The valid task was NOT locked to in_progress (validation precedes mutation).
    const t = db.prepare('SELECT status, completed_at FROM work_items WHERE id = ?').get(OPEN_TASK) as {
      status: string; completed_at: number | null
    }
    expect(t.status).toBe('open')
    expect(t.completed_at).toBeNull()

    // No workflow_run row was inserted for this project by the failed dispatch.
    const after = workflowRunsDb.listWorkflowRunsByProject.all(PROJECT_ID) as unknown[]
    expect(after.length).toBe(before.length)

    // The supervisor was never reached.
    expect(vi.mocked(startRun)).not.toHaveBeenCalled()
  })
})
