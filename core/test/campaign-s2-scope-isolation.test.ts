/**
 * Campaign S2 — run-scope isolation for lessons + work items.
 *
 * The store scopes both surfaces by owner run id via `run_id IS ?`. This file
 * pins TWO distinct realities:
 *
 *   (LOCK) Between two runs that each have a REAL runs row, isolation is total:
 *          run B can neither list nor mutate run A's lessons/work items. This is
 *          the production guarantee (every managed run injects a real K_RUN_ID).
 *
 *   (CHARACTERIZATION) Two runs whose K_RUN_ID points at NO runs row both
 *          degrade to the same `null` owner (resolveOwnerRunId returns null for a
 *          missing run). They therefore SHARE one global "null bucket" — run Y can
 *          see and mutate run X's items, and read X's lessons. Isolation only
 *          holds between runs with real, distinct rows. Documented as S2-005.
 *
 * Findings: S2-004 (real-run lesson + list-by-status isolation), S2-005 (null
 * owner bucket is shared). See testing/findings/S2-memory-work-tracking.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem, Lesson } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()
const createdWorkItemIds: string[] = []
const createdLessonIds: string[] = []

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}
const ctxA: KStoreContext = { runId: RUN_A }
const ctxB: KStoreContext = { runId: RUN_B }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `s2-iso-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/s2-iso',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id, prompt: 's2 iso fixture', cwd: '/tmp/s2-iso', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
  }
})

afterAll(() => {
  for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  for (const id of createdLessonIds) db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
  // null-owner rows created by the bucket test
  db.prepare(`DELETE FROM work_items WHERE run_id IS NULL AND title LIKE 's2-null-%'`).run()
  db.prepare(`DELETE FROM agent_memory WHERE run_id IS NULL AND lesson LIKE 's2-null-%'`).run()
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S2-004: two REAL runs are fully isolated', () => {
  it('run B cannot list or filter run A\'s lessons', () => {
    const a = call('lesson_propose', { lesson: 'A-only lesson' }, ctxA) as Lesson
    createdLessonIds.push(a.id)

    const bAll = call('lesson_list', {}, ctxB) as Lesson[]
    expect(bAll.some(l => l.id === a.id)).toBe(false)
    const bPending = call('lesson_list', { status: 'pending' }, ctxB) as Lesson[]
    expect(bPending.some(l => l.id === a.id)).toBe(false)

    // The owner still sees it.
    const aAll = call('lesson_list', {}, ctxA) as Lesson[]
    expect(aAll.some(l => l.id === a.id)).toBe(true)
  })

  it('run B cannot list-by-status or mutate run A\'s work items', () => {
    const a = call('work_item_create', { title: 'A-only ticket' }, ctxA) as WorkItem
    createdWorkItemIds.push(a.id)

    // list-by-status across the run boundary is empty for B
    const bOpen = call('work_item_list', { status: 'open' }, ctxB) as WorkItem[]
    expect(bOpen.some(w => w.id === a.id)).toBe(false)

    // mutation across the boundary reads as not-found
    expect(() => call('work_item_update', { id: a.id, status: 'done' }, ctxB)).toThrow(KStoreError)

    // owner can still mutate it
    const owned = call('work_item_update', { id: a.id, status: 'in_progress' }, ctxA) as WorkItem
    expect(owned.status).toBe('in_progress')
  })
})

describe('S2-005: the null-owner bucket is shared across runs (characterization)', () => {
  it('two unregistered run ids both collapse to null and can see/mutate each other', () => {
    // Neither id has a runs row → resolveOwnerRunId() returns null for both.
    const bogusX: KStoreContext = { runId: uuid() }
    const bogusY: KStoreContext = { runId: uuid() }

    const xItem = call('work_item_create', { title: 's2-null-x-item' }, bogusX) as WorkItem
    createdWorkItemIds.push(xItem.id)
    expect(xItem.runId).toBeNull()

    // Y (a *different* unregistered run) lists X's item — LEAK across the null bucket.
    const yList = call('work_item_list', {}, bogusY) as WorkItem[]
    expect(yList.some(w => w.id === xItem.id)).toBe(true)

    // …and Y can MUTATE it (no isolation in the null bucket).
    const mutated = call('work_item_update', { id: xItem.id, status: 'cancelled' }, bogusY) as WorkItem
    expect(mutated.status).toBe('cancelled')

    // A lesson proposed by X is visible to Y and to an explicit null run id.
    const xLesson = call('lesson_propose', { lesson: 's2-null-x-lesson' }, bogusX) as Lesson
    createdLessonIds.push(xLesson.id)
    const yLessons = call('lesson_list', {}, bogusY) as Lesson[]
    expect(yLessons.some(l => l.id === xLesson.id)).toBe(true)
    const nullLessons = call('lesson_list', {}, { runId: null }) as Lesson[]
    expect(nullLessons.some(l => l.id === xLesson.id)).toBe(true)
  })
})
