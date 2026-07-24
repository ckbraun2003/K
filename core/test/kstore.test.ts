/**
 * kstore store-layer units (Wave 5).
 *
 * Exercises the SDK-free tool handlers in core/src/mcp/k-store.ts directly
 * through the `kStoreTools` registry, against the real DB singleton with run /
 * workflow_run fixtures. Covers work-item CRUD, lesson propose/list, the
 * K_RUN_ID→workflow resolution for status-write, and the clean "not in a
 * workflow" path. The MCP transport glue (k-store-server.ts) is intentionally
 * not unit-tested here — it is exercised by the Wave 6 live-spawn integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import {
  db,
  eventsDb,
  runsDb,
  projectsDb,
  workflowRunsDb,
  workflowStepsDb,
} from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem, Lesson, WorkflowStep } from '@k/shared'

// ── fixtures: a project, a run bound to a workflow, and a plain run ───────────
const PROJECT_ID = uuid()
const RUN_WF = uuid() // a run bound to a workflow_run
const RUN_PLAIN = uuid() // a run with no workflow_run
const RUN_COLLIDE = uuid() // isolated run for the request_input seq-collision-retry test
const WF_ID = uuid()
const createdWorkItemIds: string[] = []
const createdLessonIds: string[] = []

/** Invoke a kstore tool by name through the registry (as the server would). */
function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}

const wfCtx: KStoreContext = { runId: RUN_WF }
const plainCtx: KStoreContext = { runId: RUN_PLAIN }
const collideCtx: KStoreContext = { runId: RUN_COLLIDE }
const noneCtx: KStoreContext = { runId: null }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID,
    name: `kstore-test-${PROJECT_ID.slice(0, 8)}`,
    localPath: '/tmp/kstore-test',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  for (const id of [RUN_WF, RUN_PLAIN, RUN_COLLIDE]) {
    runsDb.insertRun.run({
      id,
      prompt: 'kstore fixture',
      cwd: '/tmp/kstore-test',
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
  workflowRunsDb.insertWorkflowRun.run({
    id: WF_ID,
    projectId: PROJECT_ID,
    runId: RUN_WF,
    taskIds: '[]',
    mode: 'combined',
    workflowId: null,
    status: 'running',
    createdAt: Date.now(),
    completedAt: null,
  })
})

afterAll(() => {
  for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  for (const id of createdLessonIds) db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
  db.prepare('DELETE FROM workflow_steps WHERE workflow_run_id = ?').run(WF_ID)
  db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(WF_ID)
  // events FK-references runs(id) — must clear the request_input rows the tests below
  // insert before the run rows themselves can be deleted.
  db.prepare('DELETE FROM events WHERE run_id IN (?, ?, ?)').run(RUN_WF, RUN_PLAIN, RUN_COLLIDE)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?, ?)').run(RUN_WF, RUN_PLAIN, RUN_COLLIDE)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('kstore: work items', () => {
  it('work_item_create persists a ticket owned by the resolved run', () => {
    const item = call('work_item_create', { title: 'Implement the thing', body: 'details' }, wfCtx) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.title).toBe('Implement the thing')
    expect(item.status).toBe('open')
    expect(item.runId).toBe(RUN_WF)
    expect(item.createdAt).toBeGreaterThan(0)
  })

  it('a bogus K_RUN_ID degrades to a null owner instead of an FK error', () => {
    const item = call('work_item_create', { title: 'no real run' }, { runId: uuid() }) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.runId).toBeNull()
    expect(item.body).toBeNull()
  })

  it('work_item_list finds the created item by status, work_item_update flips it', () => {
    const created = call('work_item_create', { title: 'list + update me' }, plainCtx) as WorkItem
    createdWorkItemIds.push(created.id)

    const open = call('work_item_list', { status: 'open' }, plainCtx) as WorkItem[]
    expect(open.some(w => w.id === created.id)).toBe(true)

    const updated = call('work_item_update', { id: created.id, status: 'done' }, plainCtx) as WorkItem
    expect(updated.status).toBe('done')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    const stillOpen = call('work_item_list', { status: 'open' }, plainCtx) as WorkItem[]
    expect(stillOpen.some(w => w.id === created.id)).toBe(false)
  })

  it('work_item_update rejects an unknown id and an empty patch', () => {
    expect(() => call('work_item_update', { id: uuid(), status: 'done' }, plainCtx)).toThrow(KStoreError)
    const real = call('work_item_create', { title: 'empty patch guard' }, plainCtx) as WorkItem
    createdWorkItemIds.push(real.id)
    expect(() => call('work_item_update', { id: real.id }, plainCtx)).toThrow(KStoreError)
  })

  it('work_item_create rejects an empty title (zod boundary)', () => {
    expect(() => call('work_item_create', { title: '' }, plainCtx)).toThrow()
  })

  it('a run can neither list nor update another run\'s work items', () => {
    const mine = call('work_item_create', { title: 'wf-owned ticket' }, wfCtx) as WorkItem
    createdWorkItemIds.push(mine.id)
    // a different run does not see it…
    const plainList = call('work_item_list', {}, plainCtx) as WorkItem[]
    expect(plainList.some(w => w.id === mine.id)).toBe(false)
    // …and cannot mutate it — it reads as "not found" across the run boundary
    expect(() => call('work_item_update', { id: mine.id, status: 'done' }, plainCtx)).toThrow(KStoreError)
    // the owner still can
    const owned = call('work_item_update', { id: mine.id, status: 'in_progress' }, wfCtx) as WorkItem
    expect(owned.status).toBe('in_progress')
  })
})

describe('kstore: lessons (gated reflection)', () => {
  it('lesson_propose lands pending and lesson_list surfaces it', () => {
    const lesson = call('lesson_propose', { lesson: 'When X, do Y because Z.' }, wfCtx) as Lesson
    createdLessonIds.push(lesson.id)
    expect(lesson.status).toBe('pending')
    expect(lesson.runId).toBe(RUN_WF)
    expect(lesson.reviewedAt).toBeNull()

    const pending = call('lesson_list', { status: 'pending' }, wfCtx) as Lesson[]
    expect(pending.some(l => l.id === lesson.id)).toBe(true)
  })
})

describe('kstore: workflow status-write', () => {
  it('workflow_step_set upserts by label within the resolved workflow run', () => {
    const step = call(
      'workflow_step_set',
      { label: 'Implement X', kind: 'task', status: 'in_progress' },
      wfCtx,
    ) as WorkflowStep
    expect(step.workflowRunId).toBe(WF_ID)
    expect(step.status).toBe('in_progress')
    expect(step.seq).toBeGreaterThanOrEqual(1)
    const firstSeq = step.seq

    // same label → upsert: status changes, seq is stable
    const again = call(
      'workflow_step_set',
      { label: 'Implement X', kind: 'task', status: 'done', detail: 'shipped' },
      wfCtx,
    ) as WorkflowStep
    expect(again.seq).toBe(firstSeq)
    expect(again.status).toBe('done')
    expect(again.detail).toBe('shipped')

    // a new label → next seq, and it is a first-class CI gate
    const ci = call('workflow_step_set', { label: 'CI', kind: 'ci', status: 'pending' }, wfCtx) as WorkflowStep
    expect(ci.seq).toBe(firstSeq + 1)

    const steps = workflowStepsDb.listWorkflowSteps.all(WF_ID) as Array<{ label: string }>
    expect(steps.map(s => s.label)).toEqual(['Implement X', 'CI'])
  })

  it('workflow_step_set links an owned work item and rejects a foreign/bogus one', () => {
    const ticket = call('work_item_create', { title: 'linked ticket' }, wfCtx) as WorkItem
    createdWorkItemIds.push(ticket.id)
    const step = call(
      'workflow_step_set',
      { label: 'Linked', kind: 'task', status: 'in_progress', workItemId: ticket.id },
      wfCtx,
    ) as WorkflowStep
    expect(step.workItemId).toBe(ticket.id)
    // a work item this run does not own is rejected up front (no raw FK error)
    expect(() =>
      call('workflow_step_set', { label: 'Bad', kind: 'task', status: 'pending', workItemId: uuid() }, wfCtx),
    ).toThrow(KStoreError)
  })

  it('workflow_status_set updates the underlying workflow_runs row', () => {
    const res = call('workflow_status_set', { status: 'completed' }, wfCtx) as { ok: true; status: string }
    expect(res.ok).toBe(true)
    const row = workflowRunsDb.getWorkflowRun.get(WF_ID) as { status: string; completed_at: number | null }
    expect(row.status).toBe('completed')
    expect(row.completed_at).not.toBeNull()
  })

  it('status-write returns a clean "not in a workflow" notice off a workflow', () => {
    for (const ctx of [plainCtx, noneCtx]) {
      const step = call('workflow_step_set', { label: 'x', kind: 'phase', status: 'pending' }, ctx) as {
        ok: false
        reason: string
      }
      expect(step.ok).toBe(false)
      expect(step.reason).toBe('not_in_workflow')

      const status = call('workflow_status_set', { status: 'running' }, ctx) as { ok: false; reason: string }
      expect(status.ok).toBe(false)
      expect(status.reason).toBe('not_in_workflow')
    }
  })
})

describe('kstore: request_input (ui-adjustments R4 D1/relocation — the sole input_request producer)', () => {
  it('posts exactly one input_request event carrying the question text + kind raw', () => {
    const result = call('request_input', { question: 'Use Postgres?', kind: 'question' }, wfCtx)
    expect(typeof result).toBe('string')
    const rows = db.prepare(
      `SELECT text, raw FROM events WHERE run_id = ? AND type = 'input_request'`,
    ).all(RUN_WF) as Array<{ text: string; raw: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('Use Postgres?')
    expect(JSON.parse(rows[0].raw)).toEqual({ kind: 'question' })
  })

  it('kind defaults to "question" when omitted', () => {
    call('request_input', { question: 'Proceed with the migration?' }, plainCtx)
    const row = db.prepare(
      `SELECT raw FROM events WHERE run_id = ? AND type = 'input_request'`,
    ).get(RUN_PLAIN) as { raw: string }
    expect(JSON.parse(row.raw)).toEqual({ kind: 'question' })
  })

  it('rejects a null run context (KStoreError, not an FK crash)', () => {
    expect(() => call('request_input', { question: 'no run context' }, noneCtx)).toThrow(KStoreError)
  })

  it('a bogus K_RUN_ID also rejects (no matching runs row to own the event)', () => {
    expect(() => call('request_input', { question: 'ghost run' }, { runId: uuid() })).toThrow(KStoreError)
  })

  it('rejects an empty question (zod boundary)', () => {
    expect(() => call('request_input', { question: '' }, wfCtx)).toThrow()
  })

  it('retries past a seq collision instead of losing the ask (cross-process race simulation)', () => {
    // A concurrent writer (supervisor.ts's in-memory per-process counter, in the
    // real cross-process race) already committed seq 0 for this run.
    const occupied = eventsDb.insertEvent.run({
      id: uuid(), runId: RUN_COLLIDE, seq: 0, type: 'status', ts: Date.now(),
      text: 'running', raw: null, tool: null, tokensIn: null, tokensOut: null, costUsd: null,
      toolUseId: null, toolKind: null, toolInput: null, toolResult: null, toolResultIsError: null,
      subagentType: null, childLabel: null, contextTokens: null,
    })
    expect(occupied.changes).toBe(1)

    // Force requestInput's FIRST attempt to compute the ALREADY-occupied seq (a
    // stale read, exactly what a racing cross-process reader would see) so its own
    // INSERT OR IGNORE lands changes:0 — then let the real statement answer every
    // later call, so the retry's re-read finds the true next-free seq. This proves
    // the LOOP saves the ask, not merely that a sequential re-read would.
    const realGet = eventsDb.nextEventSeq.get.bind(eventsDb.nextEventSeq)
    const spy = vi.spyOn(eventsDb.nextEventSeq, 'get')
      .mockReturnValueOnce({ next: 0 } as never)
      .mockImplementation((...args: unknown[]) => (realGet as (...a: unknown[]) => unknown)(...args))

    try {
      const result = call('request_input', { question: 'racy ask' }, collideCtx)
      expect(typeof result).toBe('string')
    } finally {
      spy.mockRestore()
    }

    const rows = db.prepare(
      `SELECT seq, text, raw FROM events WHERE run_id = ? AND type = 'input_request'`,
    ).all(RUN_COLLIDE) as Array<{ seq: number; text: string; raw: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('racy ask')
    expect(rows[0].seq).toBeGreaterThan(0) // NOT the collided seq — the retry's fresh seq
    expect(JSON.parse(rows[0].raw)).toEqual({ kind: 'question' })
  })
})
