/**
 * Campaign S3 — kstore tool-layer input-schema validation (LOCK / gating).
 *
 * Adversarial coverage of the AUTHORITATIVE zod validation inside the kstore
 * handlers (core/src/mcp/k-store.ts), invoked directly through the `kStoreTools`
 * registry exactly as k-store-server.ts does. Complements core/test/kstore.test.ts
 * (which covers the happy-path CRUD + run-scope semantics) with the vectors S3
 * owns: wrong types, null/undefined, extra-arg stripping, oversized/boundary
 * payloads, limit + enum bounds, injection-string verbatim storage, and the
 * KStoreError-vs-ZodError type distinction the server's error masking keys off.
 *
 * Findings: S3-002, S3-005, S3-010, S3-011 (testing/findings/S3-kstore-mcp.md).
 * All assertions characterize CURRENT, CORRECT behavior → this file must stay GREEN.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { ZodError } from 'zod'
import {
  db,
  runsDb,
  projectsDb,
  workflowRunsDb,
} from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem } from '@k/shared'

// ── fixtures ──────────────────────────────────────────────────────────────────
const PROJECT_ID = uuid()
const RUN_PLAIN = uuid()
const RUN_WF = uuid()
const WF_ID = uuid()
const createdWorkItemIds: string[] = []
const createdLessonIds: string[] = []

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}

const plainCtx: KStoreContext = { runId: RUN_PLAIN }
const wfCtx: KStoreContext = { runId: RUN_WF }

/** Capture a thrown error so its concrete type can be asserted. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw, but it returned')
}

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID,
    name: `s3-val-${PROJECT_ID.slice(0, 8)}`,
    localPath: '/tmp/s3-val',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  for (const id of [RUN_PLAIN, RUN_WF]) {
    runsDb.insertRun.run({
      id,
      prompt: 's3 validation fixture',
      cwd: '/tmp/s3-val',
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
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_PLAIN, RUN_WF)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S3 kstore validation: wrong types are rejected (ZodError, not KStoreError)', () => {
  it('rejects a non-string title / body', () => {
    expect(() => call('work_item_create', { title: 123 }, plainCtx)).toThrow(ZodError)
    expect(() => call('work_item_create', { title: 'ok', body: 123 }, plainCtx)).toThrow(ZodError)
  })

  it('rejects a non-number / non-integer limit', () => {
    expect(() => call('work_item_list', { limit: '5' }, plainCtx)).toThrow(ZodError)
    expect(() => call('work_item_list', { limit: true }, plainCtx)).toThrow(ZodError)
    expect(() => call('lesson_list', { limit: '5' }, plainCtx)).toThrow(ZodError)
  })

  it('rejects a non-string lesson / label', () => {
    expect(() => call('lesson_propose', { lesson: 123 }, plainCtx)).toThrow(ZodError)
    expect(() => call('workflow_step_set', { label: 123, kind: 'task', status: 'pending' }, wfCtx)).toThrow(ZodError)
  })
})

describe('S3 kstore validation: null / undefined args (S3-011)', () => {
  it('a required-field tool throws a ZodError (NOT a KStoreError) on undefined/null', () => {
    // The distinction matters: the server masks any non-KStoreError as a generic
    // "internal error", so a ZodError carries caller-facing validation detail only
    // through the SDK's first-pass validation — never through the handler's catch.
    const errUndef = thrownBy(() => call('work_item_create', undefined, plainCtx))
    expect(errUndef).toBeInstanceOf(ZodError)
    expect(errUndef).not.toBeInstanceOf(KStoreError)

    const errNull = thrownBy(() => call('work_item_create', null, plainCtx))
    expect(errNull).toBeInstanceOf(ZodError)
  })

  it('an empty patch on a real item throws a KStoreError (caller-facing), proving the type split', () => {
    const real = call('work_item_create', { title: 'type-split guard' }, plainCtx) as WorkItem
    createdWorkItemIds.push(real.id)
    const err = thrownBy(() => call('work_item_update', { id: real.id }, plainCtx))
    expect(err).toBeInstanceOf(KStoreError)
    expect(err).not.toBeInstanceOf(ZodError)
  })
})

describe('S3 kstore validation: extra args are silently stripped (S3-002)', () => {
  it('ignores unknown keys instead of rejecting them', () => {
    // NB: the advertised JSON-Schema carries additionalProperties:false, yet the
    // zod object (non-strict) STRIPS unknowns and succeeds — a contract the server
    // honors permissively. The stored row never gains the injected keys.
    const item = call(
      'work_item_create',
      { title: 'keeps only known keys', bogus: 'y', __proto__hack: 1, evil: { a: 1 } },
      plainCtx,
    ) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.title).toBe('keeps only known keys')
    expect(Object.keys(item).sort()).toEqual(
      ['body', 'createdAt', 'id', 'runId', 'status', 'title', 'updatedAt'].sort(),
    )
    expect((item as Record<string, unknown>).bogus).toBeUndefined()
  })
})

describe('S3 kstore validation: oversized payloads rejected at max+1, accepted at max (S3-005)', () => {
  it('rejects strings one over their max length', () => {
    expect(() => call('work_item_create', { title: 'a'.repeat(501) }, plainCtx)).toThrow(ZodError)
    expect(() => call('work_item_create', { title: 'ok', body: 'b'.repeat(20_001) }, plainCtx)).toThrow(ZodError)
    expect(() => call('lesson_propose', { lesson: 'l'.repeat(4_001) }, plainCtx)).toThrow(ZodError)
    expect(() => call('workflow_step_set', { label: 'x'.repeat(201), kind: 'task', status: 'pending' }, wfCtx)).toThrow(ZodError)
    expect(() =>
      call('workflow_step_set', { label: 'ok', kind: 'task', status: 'pending', detail: 'd'.repeat(2_001) }, wfCtx),
    ).toThrow(ZodError)
  })

  it('accepts strings at exactly their max length', () => {
    const item = call('work_item_create', { title: 'a'.repeat(500), body: 'b'.repeat(20_000) }, plainCtx) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.title.length).toBe(500)
    expect(item.body?.length).toBe(20_000)

    const lesson = call('lesson_propose', { lesson: 'l'.repeat(4_000) }, plainCtx) as { id: string }
    createdLessonIds.push(lesson.id)

    const step = call(
      'workflow_step_set',
      { label: 'L'.repeat(200), kind: 'task', status: 'pending', detail: 'd'.repeat(2_000) },
      wfCtx,
    ) as { label: string; detail: string }
    expect(step.label.length).toBe(200)
    expect(step.detail.length).toBe(2_000)
  })
})

describe('S3 kstore validation: limit bounds (S3-005)', () => {
  it('rejects 0, >200, fractional and negative limits; accepts 1 and 200', () => {
    for (const bad of [0, 201, 1.5, -1, Number.NaN]) {
      expect(() => call('work_item_list', { limit: bad }, plainCtx)).toThrow(ZodError)
    }
    expect(Array.isArray(call('work_item_list', { limit: 1 }, plainCtx))).toBe(true)
    expect(Array.isArray(call('work_item_list', { limit: 200 }, plainCtx))).toBe(true)
  })
})

describe('S3 kstore validation: enum bounds (S3-005)', () => {
  it('rejects out-of-enum status / kind values', () => {
    expect(() => call('work_item_list', { status: 'bogus' }, plainCtx)).toThrow(ZodError)
    expect(() => call('work_item_update', { id: uuid(), status: 'bogus' }, plainCtx)).toThrow(ZodError)
    expect(() => call('lesson_list', { status: 'bogus' }, plainCtx)).toThrow(ZodError)
    expect(() => call('workflow_step_set', { label: 'x', kind: 'bogus', status: 'pending' }, wfCtx)).toThrow(ZodError)
    expect(() => call('workflow_step_set', { label: 'x', kind: 'task', status: 'bogus' }, wfCtx)).toThrow(ZodError)
    expect(() => call('workflow_status_set', { status: 'bogus' }, wfCtx)).toThrow(ZodError)
    // 'queued' is a run status but NOT a valid work-item status → rejected.
    expect(() => call('work_item_list', { status: 'queued' }, plainCtx)).toThrow(ZodError)
  })
})

describe('S3 kstore validation: injection-ish strings are stored verbatim (S3-010)', () => {
  it('treats SQL-injection payloads as plain data via parameterized statements', () => {
    const payload = "Robert'); DROP TABLE work_items;-- and   NUL and 😈 unicode"
    const item = call('work_item_create', { title: payload }, plainCtx) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.title).toBe(payload)
    // The table is intact (no SQL executed) and the row round-trips by id.
    const again = call('work_item_update', { id: item.id, status: 'done' }, plainCtx) as WorkItem
    expect(again.title).toBe(payload)
    expect(again.status).toBe('done')
    expect(Array.isArray(call('work_item_list', {}, plainCtx))).toBe(true)
  })
})
