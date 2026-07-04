/**
 * Campaign S2 — workflow_run finalize semantics + completion invariant (LOCK).
 *
 * Pins the authority model around a workflow_run's terminal state:
 *   - workflow_status_set (the agent's write) is a MID-RUN advisory; the
 *     supervisor's finalizeWorkflowRun re-derives the status from the actual run
 *     outcome at termination and wins (S2-013);
 *   - an agent can flip a 'completed' workflow back to 'running' mid-run — the
 *     overall status is NOT a sticky terminal until the supervisor finalizes
 *     (characterization, S2-014);
 *   - finalizeWorkflowRun is last-writer-wins — it has no terminal lock of its
 *     own (S2-015);
 *   - COMPLETION INVARIANT: a successful (terminal 'done') dispatch finalizes the
 *     workflow_run to 'completed' but the selected tasks stay
 *     'in_progress' — the harness NEVER auto-marks a todo 'done'; the PR does
 *     (S2-016).
 *
 * startRun is mocked (mirrors workflows.test.ts) so no real agent spawns; the
 * mock inserts a real runs row because workflow_runs.run_id FK → runs(id).
 * See testing/findings/S2-memory-work-tracking.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb, projectWorkItemsDb, workflowRunsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { kStoreTools, type KStoreContext } from '../src/mcp/k-store.js'
import type { Project, Run } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-s2fin-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'wf', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { finalizeWorkflowRun, dispatchTaskWorkflow } = await import('../src/workflows.js')

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}

const PROJECT_ID = uuid()
const project: Project = {
  id: PROJECT_ID, name: `s2-fin-${PROJECT_ID.slice(0, 8)}`, localPath: '.',
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
  db.prepare('DELETE FROM work_items WHERE project_id = ?').run(PROJECT_ID)
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-s2fin-run-%'`).run()
  db.prepare('DELETE FROM runs WHERE prompt = ?').run('s2 fin status fixture')
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

/** Seed a run + workflow_run bound to it; return their ids. */
function seedWorkflow(): { runId: string; wfId: string } {
  const runId = uuid()
  const wfId = uuid()
  runsDb.insertRun.run({
    id: runId, prompt: 's2 fin status fixture', cwd: '.', worktree: null, status: 'running',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
  workflowRunsDb.insertWorkflowRun.run({
    id: wfId, projectId: PROJECT_ID, runId, taskIds: '[]', mode: 'combined',
    workflowId: null, status: 'running', createdAt: Date.now(), completedAt: null,
  })
  return { runId, wfId }
}

describe('S2-013: the supervisor finalize overrides an agent\'s mid-run status', () => {
  it('agent set "completed", but a failed terminal finalize lands "failed"', () => {
    const { runId, wfId } = seedWorkflow()
    const res = call('workflow_status_set', { status: 'completed' }, { runId }) as { ok: true }
    expect(res.ok).toBe(true)
    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { status: string }).status).toBe('completed')

    // The run actually ended in error → finalize re-derives to 'failed' and wins.
    finalizeWorkflowRun(wfId, 'error')
    const row = workflowRunsDb.getWorkflowRun.get(wfId) as { status: string; completed_at: number | null }
    expect(row.status).toBe('failed')
    expect(row.completed_at).not.toBeNull()
  })
})

describe('S2-014: overall status is not sticky mid-run (characterization)', () => {
  it('workflow_status_set can move completed → running again (clears completed_at)', () => {
    const { runId, wfId } = seedWorkflow()
    call('workflow_status_set', { status: 'completed' }, { runId })
    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { completed_at: number | null }).completed_at).not.toBeNull()

    call('workflow_status_set', { status: 'running' }, { runId })
    const row = workflowRunsDb.getWorkflowRun.get(wfId) as { status: string; completed_at: number | null }
    expect(row.status).toBe('running')
    expect(row.completed_at).toBeNull()
  })
})

describe('S2-015: finalizeWorkflowRun is last-writer-wins (no terminal lock)', () => {
  it('a second finalize overwrites the first', () => {
    const { wfId } = seedWorkflow()
    finalizeWorkflowRun(wfId, 'done')
    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { status: string }).status).toBe('completed')
    finalizeWorkflowRun(wfId, 'error')
    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { status: string }).status).toBe('failed')
  })
})

describe('S2-016: a successful dispatch never auto-marks the todos done', () => {
  it('terminal "done" finalizes the workflow_run completed, tasks STAY in_progress', async () => {
    const taskA = uuid()
    const taskB = uuid()
    for (const [id, title] of [[taskA, 'todo A'], [taskB, 'todo B']] as const) {
      projectWorkItemsDb.insertProjectTask.run({
        id, projectId: PROJECT_ID, title, status: 'open', createdAt: Date.now(),
        completedAt: null, issueNumber: null, issueUrl: null, issueState: null,
      })
    }

    const { workflowRunId, runId } = await dispatchTaskWorkflow(project, [taskA, taskB])

    // Drive the live finalize path with a terminal 'done' run update.
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    // The workflow_run is completed…
    const wf = workflowRunsDb.getWorkflowRun.get(workflowRunId) as { status: string }
    expect(wf.status).toBe('completed')

    // …but BOTH todos remain in_progress — the harness did NOT auto-mark done.
    for (const id of [taskA, taskB]) {
      const t = db.prepare('SELECT status, completed_at FROM work_items WHERE id = ?').get(id) as
        { status: string; completed_at: number | null }
      expect(t.status).toBe('in_progress')
      expect(t.completed_at).toBeNull()
    }
  })
})
