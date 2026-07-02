/**
 * A1 — durable operator-global work items (kstore).
 *
 * The run-scoped default is RENAMED 'personal' → 'run' (ephemeral, single-run);
 * 'personal'/'org' become the DURABLE operator-global store (visible + updatable
 * from ANY run). 'project' creation is rejected (projects API owns that surface).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()
const createdWorkItemIds: string[] = []

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const t = kStoreTools.find(x => x.name === name)
  if (!t) throw new Error(`no such kstore tool: ${name}`)
  return t.handler(args, ctx)
}
const ctxA: KStoreContext = { runId: RUN_A }
const ctxB: KStoreContext = { runId: RUN_B }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `a1-durable-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/a1-durable',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id, prompt: 'a1 durable fixture', cwd: '/tmp/a1-durable', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
  }
})

afterAll(() => {
  for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  db.prepare(`DELETE FROM work_items WHERE run_id IS NULL AND title LIKE 'a1-durable-null-%'`).run()
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('A1 durable work items', () => {
  it('create WITHOUT scope defaults to run (ephemeral)', () => {
    const item = call('work_item_create', { title: 'default run' }, ctxA) as WorkItem
    createdWorkItemIds.push(item.id)
    expect(item.scope).toBe('run')
  })

  it('a personal item created in run A is listed + updatable from run B (durable)', () => {
    const created = call('work_item_create', { title: 'A personal', scope: 'personal' }, ctxA) as WorkItem
    createdWorkItemIds.push(created.id)
    expect(created.scope).toBe('personal')

    const bList = call('work_item_list', { scope: 'personal' }, ctxB) as WorkItem[]
    expect(bList.some(w => w.id === created.id)).toBe(true)

    const byB = call('work_item_update', { id: created.id, status: 'done' }, ctxB) as WorkItem
    expect(byB.status).toBe('done')
    expect(byB.scope).toBe('personal') // scope is never altered by an update
  })

  it('an org item created in run A is listed + updatable from run B (durable)', () => {
    const created = call('work_item_create', { title: 'A org', scope: 'org' }, ctxA) as WorkItem
    createdWorkItemIds.push(created.id)
    expect(created.scope).toBe('org')

    const bList = call('work_item_list', { scope: 'org' }, ctxB) as WorkItem[]
    expect(bList.some(w => w.id === created.id)).toBe(true)

    const byB = call('work_item_update', { id: created.id, status: 'in_progress' }, ctxB) as WorkItem
    expect(byB.status).toBe('in_progress')
  })

  it('durable items are ABSENT from the default (run) list', () => {
    const personal = call('work_item_create', { title: 'hidden personal', scope: 'personal' }, ctxA) as WorkItem
    const org = call('work_item_create', { title: 'hidden org', scope: 'org' }, ctxA) as WorkItem
    createdWorkItemIds.push(personal.id, org.id)

    const runList = call('work_item_list', {}, ctxA) as WorkItem[]
    expect(runList.some(w => w.id === personal.id)).toBe(false)
    expect(runList.some(w => w.id === org.id)).toBe(false)
    // and every row the default list DOES return is run-scoped
    expect(runList.every(w => w.scope === 'run')).toBe(true)
  })

  it('create scope:project is rejected with a clear KStoreError', () => {
    expect(() => call('work_item_create', { title: 'nope', scope: 'project' }, ctxA))
      .toThrow(/projects surface/i)
    expect(() => call('work_item_create', { title: 'nope', scope: 'project' }, ctxA))
      .toThrow(KStoreError)
    // list with scope:project is likewise rejected (advertised schema excludes it)
    expect(() => call('work_item_list', { scope: 'project' }, ctxA)).toThrow(KStoreError)
  })

  it('run isolation for the default (run) scope still holds between two real runs', () => {
    const mine = call('work_item_create', { title: 'A run ticket' }, ctxA) as WorkItem
    createdWorkItemIds.push(mine.id)
    const bList = call('work_item_list', {}, ctxB) as WorkItem[]
    expect(bList.some(w => w.id === mine.id)).toBe(false)
    expect(() => call('work_item_update', { id: mine.id, status: 'done' }, ctxB)).toThrow(KStoreError)
    const owned = call('work_item_update', { id: mine.id, status: 'blocked' }, ctxA) as WorkItem
    expect(owned.status).toBe('blocked')
  })

  it('a null-owner ctx can still create + list run items in the shared null bucket', () => {
    const x = call('work_item_create', { title: 'a1-durable-null-x' }, { runId: null }) as WorkItem
    expect(x.scope).toBe('run')
    expect(x.runId).toBeNull()
    const nullList = call('work_item_list', {}, { runId: null }) as WorkItem[]
    expect(nullList.some(w => w.id === x.id)).toBe(true)
  })
})
