/**
 * Campaign S2 — work-item lifecycle (LOCK suite).
 *
 * work_item_update has NO transition state machine: any value in
 * WorkItemStatusSchema is freely settable regardless of the current status, and
 * the terminal states ('done', 'cancelled') can be re-entered/re-opened. The
 * only guard is the zod enum at the edge. These LOCKs pin that observed contract
 * so a future "state machine" change is a deliberate, visible decision.
 *
 * Findings: S2-006 (no transition guard / terminal re-entry), S2-007 (enum
 * validation), S2-008 (partial-patch field semantics).
 * See testing/findings/S2-memory-work-tracking.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { kStoreTools, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkItem } from '@k/shared'

const PROJECT_ID = uuid()
const RUN = uuid()
const createdWorkItemIds: string[] = []

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}
const ctx: KStoreContext = { runId: RUN }

function newItem(title = 'lifecycle item'): WorkItem {
  const item = call('work_item_create', { title }, ctx) as WorkItem
  createdWorkItemIds.push(item.id)
  return item
}

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `s2-life-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/s2-life',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  runsDb.insertRun.run({
    id: RUN, prompt: 's2 life fixture', cwd: '/tmp/s2-life', worktree: null, status: 'running',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
})

afterAll(() => {
  for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S2-006: every enum transition is permitted (no state machine)', () => {
  it('walks the full chain open→in_progress→blocked→done→cancelled', () => {
    const item = newItem()
    expect(item.status).toBe('open')
    for (const status of ['in_progress', 'blocked', 'done', 'cancelled'] as const) {
      const u = call('work_item_update', { id: item.id, status }, ctx) as WorkItem
      expect(u.status).toBe(status)
    }
  })

  it('re-enters / reverses terminal states: done→in_progress, cancelled→open, blocked→done', () => {
    const a = newItem('a')
    call('work_item_update', { id: a.id, status: 'done' }, ctx)
    const reopened = call('work_item_update', { id: a.id, status: 'in_progress' }, ctx) as WorkItem
    expect(reopened.status).toBe('in_progress') // terminal re-entry: done is NOT sticky

    const b = newItem('b')
    call('work_item_update', { id: b.id, status: 'cancelled' }, ctx)
    const uncancelled = call('work_item_update', { id: b.id, status: 'open' }, ctx) as WorkItem
    expect(uncancelled.status).toBe('open') // cancelled is NOT sticky either

    const c = newItem('c')
    call('work_item_update', { id: c.id, status: 'blocked' }, ctx)
    const done = call('work_item_update', { id: c.id, status: 'done' }, ctx) as WorkItem
    expect(done.status).toBe('done')
  })
})

describe('S2-007: status enum is validated at the edge', () => {
  it('rejects a value outside WorkItemStatusSchema', () => {
    const item = newItem('enum guard')
    for (const bad of ['archived', 'closed', 'DONE', 'completed', '']) {
      expect(() => call('work_item_update', { id: item.id, status: bad } as unknown, ctx)).toThrow()
    }
    // sanity: the item was never mutated by the rejected calls
    const open = call('work_item_list', { status: 'open' }, ctx) as WorkItem[]
    expect(open.some(w => w.id === item.id)).toBe(true)
  })
})

describe('S2-008: partial patch only touches the supplied fields', () => {
  it('title-only patch preserves status + body; status-only preserves title; body:"" clears body', () => {
    const item = call('work_item_create', { title: 'orig title', body: 'orig body' }, ctx) as WorkItem
    createdWorkItemIds.push(item.id)
    call('work_item_update', { id: item.id, status: 'in_progress' }, ctx)

    // title-only: status (in_progress) and body (orig body) survive
    const t = call('work_item_update', { id: item.id, title: 'new title' }, ctx) as WorkItem
    expect(t.title).toBe('new title')
    expect(t.status).toBe('in_progress')
    expect(t.body).toBe('orig body')

    // status-only: title survives
    const s = call('work_item_update', { id: item.id, status: 'blocked' }, ctx) as WorkItem
    expect(s.title).toBe('new title')
    expect(s.status).toBe('blocked')

    // body:'' is an explicit clear (distinct from "field omitted")
    const cleared = call('work_item_update', { id: item.id, body: '' }, ctx) as WorkItem
    expect(cleared.body).toBe('')
    expect(cleared.title).toBe('new title')
  })
})
