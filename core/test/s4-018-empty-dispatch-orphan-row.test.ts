/**
 * REGRESSION — FAULT S4-018 (FIXED + promoted to gating, reboot wave F1.W4b).
 *
 * dispatchTaskWorkflow validates a MISSING task id up-front (step 1) and throws
 * TaskNotFoundError BEFORE any mutation — so a bad id leaves no locked task and
 * no workflow_run row (see the green LOCK in campaign-s4-dispatch-lock-hygiene).
 * But an EMPTY taskIds array is NOT validated up-front: steps 1+2 iterate an
 * empty list (no-ops), step 3 INSERTS the workflow_run row ('running'), then step
 * 4 calls `buildDelegationPrompt(tasks)` INSIDE the try — which throws "requires
 * at least one task". The catch finalizes the row to 'failed' (it does not delete
 * it) and re-throws. Net: an empty dispatch leaves a spurious 'failed'
 * workflow_run row behind — orphaned state from what should be a pure input
 * rejection, inconsistent with the TaskNotFoundError path.
 *
 *   Surface: core/src/workflows.ts::dispatchTaskWorkflow (steps 3 insert + 4
 *   try/catch; buildDelegationPrompt([]) throws at workflows.ts:50).
 *   Reachability: the route guards taskIds 1..50, so this is reached by direct
 *   callers of the exported dispatchTaskWorkflow whose own contract is violated.
 *
 *   Expected: an empty-taskIds dispatch is rejected with NO workflow_run row
 *             written (validate-before-mutate, matching the TaskNotFound path).
 *   Actual:   one 'failed' workflow_run row is inserted and left behind.
 *
 * This test asserts the EXPECTED (safe) behavior, so it is RED against current
 * source. When dispatchTaskWorkflow validates a non-empty taskIds before
 * inserting (or rolls the row back on the buildDelegationPrompt throw), it flips
 * green → move into core/test/.
 *
 * Finding row: testing/findings/S4-prompt-delegation.md  (S4-018)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, projectsDb, workflowRunsDb } from '../src/db.js'
import type { Project } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    // Must never be reached: the step-0 empty-taskIds guard throws before
    // dispatchTaskWorkflow ever reaches startRun (pre-fix it was buildDelegationPrompt([])).
    startRun: vi.fn(async () => {
      const id = `mock-s4018-run-${uuid().slice(0, 8)}`
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
  id: PROJECT_ID, name: `s4-018-${PROJECT_ID.slice(0, 8)}`, localPath: '.',
  workspaceManaged: false, bibleDir: 'docs/bible', createdAt: Date.now(),
}

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: project.name, localPath: project.localPath,
    githubRemote: null, workspaceManaged: 0, bibleDir: project.bibleDir, createdAt: project.createdAt,
  })
})

afterAll(() => {
  db.prepare('DELETE FROM workflow_runs WHERE project_id = ?').run(PROJECT_ID)
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-s4018-run-%'`).run()
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S4-018: an empty-taskIds dispatch must not leave an orphaned workflow_run row', () => {
  it('writes NO workflow_run row when taskIds is empty', async () => {
    await expect(dispatchTaskWorkflow(project, [])).rejects.toThrow(/at least one task/)

    const rows = workflowRunsDb.listWorkflowRunsByProject.all(PROJECT_ID) as { status: string }[]
    // EXPECTED (safe): validate-before-mutate → no row was ever inserted.
    // CURRENT (fault): one 'failed' row was inserted then left behind → this is RED.
    expect(rows.length).toBe(0)
  })
})
