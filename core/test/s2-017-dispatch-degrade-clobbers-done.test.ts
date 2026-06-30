/**
 * REGRESSION — Finding S2-017 (FIXED + promoted to gating, reboot wave F1.W2).
 *
 * dispatchTaskWorkflow flips EVERY selected task to 'in_progress' unconditionally
 * (step 2), without recording or checking its prior status. On the degrade path
 * (startRun throws) it then reverts each task to a HARD-CODED 'open' — not to the
 * status it actually had. So if a task was already 'done' (completed_at set) when
 * it was selected, a *failed* dispatch silently un-completes it: status 'done' →
 * 'open', completed_at → null. That is data loss on an error path the user did
 * not cause.
 *
 *   Surface: core/src/workflows.ts::dispatchTaskWorkflow (steps 2 + 4 catch).
 *   Reachable from POST /api/projects/:id/tasks/dispatch — the route validates
 *   taskIds are uuids and 1..50 in count, but does NOT filter by status, so a
 *   'done' task id can be dispatched.
 *
 *   Expected: a failed dispatch leaves a previously-done task untouched
 *             (status 'done', completed_at preserved).
 *   Actual:   status 'open', completed_at null (completion destroyed).
 *
 * FIXED: the degrade path now restores each task to the prior (status,
 * completed_at) captured before the in_progress lock (instead of hard-coding
 * 'open'/null), so a selected 'done' task stays done → this test gates.
 *
 * Finding row: testing/findings/S2-memory-work-tracking.md  (S2-017)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, projectsDb } from '../src/db.js'
import { startRun } from '../src/supervisor.js'
import type { Project } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-s2017-run-${uuid().slice(0, 8)}`
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
  id: PROJECT_ID, name: `s2-017-${PROJECT_ID.slice(0, 8)}`, localPath: '.',
  workspaceManaged: false, bibleDir: 'docs/bible', createdAt: Date.now(),
}
const DONE_TASK = uuid()
const COMPLETED_AT = Date.now() - 10_000

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: project.name, localPath: project.localPath,
    githubRemote: null, workspaceManaged: 0, bibleDir: project.bibleDir, createdAt: project.createdAt,
  })
  // A task that is already DONE before any workflow touches it.
  db.prepare(
    `INSERT INTO project_tasks (id, project_id, title, status, created_at, completed_at)
     VALUES (?, ?, 'already shipped', 'done', ?, ?)`,
  ).run(DONE_TASK, PROJECT_ID, Date.now(), COMPLETED_AT)
})

afterAll(() => {
  db.prepare('DELETE FROM workflow_runs WHERE project_id = ?').run(PROJECT_ID)
  db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(PROJECT_ID)
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-s2017-run-%'`).run()
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S2-017: a failed dispatch must not un-complete a previously-done task', () => {
  it('preserves status="done" + completed_at after startRun throws', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(dispatchTaskWorkflow(project, [DONE_TASK])).rejects.toThrow(/spawn failed/)

    const t = db.prepare('SELECT status, completed_at FROM project_tasks WHERE id = ?').get(DONE_TASK) as {
      status: string
      completed_at: number | null
    }
    // EXPECTED (safe): the done task is untouched by a failed dispatch.
    // CURRENT (fault): status === 'open', completed_at === null  →  this is RED.
    expect(t.status).toBe('done')
    expect(t.completed_at).toBe(COMPLETED_AT)
  })
})
