/**
 * Wave A1 — characterization (LOCK): behavior that must SURVIVE the durable
 * operator-global store change. Written against the UNMODIFIED source so it is
 * GREEN before the change AND after it. Deliberately asserts BEHAVIOR, never the
 * literal scope value ('run' vs 'personal'), so it cannot pin a value the change
 * renames.
 *
 * Pins four contracts the A1 change must keep:
 *   1. kstore run isolation between two REAL runs (default-scope create): run B
 *      neither lists nor mutates run A's ticket; owner A can.
 *   2. project surface: a projectWorkItemsDb row (scope='project') is invisible to the
 *      kstore work_item_list and not mutable via work_item_update.
 *   3. logistics: note/event/reminder CRUD round-trip shapes + run_id provenance
 *      recorded on insert.
 *   4. mgmt: assignment/report write round-trip shapes (rowToAssignment/rowToReport).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb, projectWorkItemsDb } from '../src/db.js'
import { kStoreTools, KStoreError, type KStoreContext } from '../src/mcp/k-store.js'
import { logisticsTools, type LogisticsContext } from '../src/mcp/logistics.js'
import { mgmtTools, type MgmtContext } from '../src/mcp/mgmt.js'
import { seedProfiles } from '../src/profiles.js'
import type { WorkItem, Note, CalendarEvent, Reminder, Assignment, MgmtReport } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()
const createdWorkItemIds: string[] = []
const projectTaskId = uuid()

function kcall(name: string, args: unknown, ctx: KStoreContext): unknown {
  const t = kStoreTools.find(x => x.name === name)
  if (!t) throw new Error(`no such kstore tool: ${name}`)
  return t.handler(args, ctx)
}
function lcall(name: string, args: unknown, ctx: LogisticsContext): unknown {
  const t = logisticsTools.find(x => x.name === name)
  if (!t) throw new Error(`no such logistics tool: ${name}`)
  return t.handler(args, ctx)
}
function mcall(name: string, args: unknown, ctx: MgmtContext): unknown {
  const t = mgmtTools.find(x => x.name === name)
  if (!t) throw new Error(`no such mgmt tool: ${name}`)
  return t.handler(args, ctx)
}

const ctxA: KStoreContext = { runId: RUN_A }
const ctxB: KStoreContext = { runId: RUN_B }

beforeAll(() => {
  // assign_lead resolves the lead against the durable roster now (F-067) — seed it
  // (idempotent) so 'Backend' resolves in the mgmt round-trip test regardless of file order.
  seedProfiles()
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `a1-char-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/a1-char',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id, prompt: 'a1 char fixture', cwd: '/tmp/a1-char', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
  }
  projectWorkItemsDb.insertProjectTask.run({
    id: projectTaskId, projectId: PROJECT_ID, title: 'a1-char project task', status: 'open',
    createdAt: Date.now(), completedAt: null, issueNumber: null, issueUrl: null, issueState: null,
  })
})

afterAll(() => {
  for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  db.prepare('DELETE FROM work_items WHERE id = ?').run(projectTaskId)
  db.prepare('DELETE FROM logistics_notes WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_events WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_reminders WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM mgmt_reports WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM mgmt_assignments WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('A1 char: kstore run isolation (default-scope create, two real runs)', () => {
  it('run B cannot list or update run A\'s default-scope ticket; owner A can', () => {
    const mine = kcall('work_item_create', { title: 'A default ticket' }, ctxA) as WorkItem
    createdWorkItemIds.push(mine.id)

    const bList = kcall('work_item_list', {}, ctxB) as WorkItem[]
    expect(bList.some(w => w.id === mine.id)).toBe(false)
    expect(() => kcall('work_item_update', { id: mine.id, status: 'done' }, ctxB)).toThrow(KStoreError)

    const owned = kcall('work_item_update', { id: mine.id, status: 'in_progress' }, ctxA) as WorkItem
    expect(owned.status).toBe('in_progress')
    const aList = kcall('work_item_list', {}, ctxA) as WorkItem[]
    expect(aList.some(w => w.id === mine.id)).toBe(true)
  })
})

describe('A1 char: project surface stays isolated from kstore', () => {
  it('a project-scoped row is invisible to work_item_list and not mutable via work_item_update', () => {
    for (const ctx of [ctxA, { runId: null } as KStoreContext]) {
      const list = kcall('work_item_list', {}, ctx) as WorkItem[]
      expect(list.some(w => w.id === projectTaskId)).toBe(false)
      expect(() => kcall('work_item_update', { id: projectTaskId, status: 'done' }, ctx)).toThrow(KStoreError)
    }
    // the row genuinely exists in the project surface
    const listed = projectWorkItemsDb.listProjectTasks.all(PROJECT_ID) as Array<{ id: string }>
    expect(listed.some(t => t.id === projectTaskId)).toBe(true)
  })
})

describe('A1 char: logistics CRUD round-trip shapes + run_id provenance', () => {
  it('note/event/reminder insert record run_id and round-trip their shapes', () => {
    const note = lcall('note_add', { body: 'char note' }, { runId: RUN_A }) as Note
    expect(note.body).toBe('char note')
    expect(note.done).toBe(false)
    expect(note.runId).toBe(RUN_A)
    expect(note.createdAt).toBeGreaterThan(0)
    const noteList = lcall('note_list', {}, { runId: RUN_A }) as Note[]
    expect(noteList.some(n => n.id === note.id)).toBe(true)

    const ev = lcall('event_add', { title: 'char event', startsAt: 1000, endsAt: 1500, location: 'here' }, { runId: RUN_A }) as CalendarEvent
    expect(ev.title).toBe('char event')
    expect(ev.startsAt).toBe(1000)
    expect(ev.endsAt).toBe(1500)
    expect(ev.location).toBe('here')
    expect(ev.runId).toBe(RUN_A)
    const evList = lcall('event_list', {}, { runId: RUN_A }) as CalendarEvent[]
    expect(evList.some(e => e.id === ev.id)).toBe(true)

    const rem = lcall('reminder_add', { text: 'char reminder', remindAt: 42 }, { runId: RUN_A }) as Reminder
    expect(rem.text).toBe('char reminder')
    expect(rem.status).toBe('pending')
    expect(rem.remindAt).toBe(42)
    expect(rem.runId).toBe(RUN_A)
    const remList = lcall('reminder_list', {}, { runId: RUN_A }) as Reminder[]
    expect(remList.some(r => r.id === rem.id)).toBe(true)
  })
})

describe('A1 char: mgmt write round-trip shapes', () => {
  it('assign_lead + report round-trip their shapes with run_id provenance', () => {
    const a = mcall('assign_lead', { lead: 'Backend', objective: 'char objective', note: 'n' }, { runId: RUN_A }) as Assignment
    expect(a.lead).toBe('Backend')
    expect(a.objective).toBe('char objective')
    expect(a.note).toBe('n')
    expect(a.workflow).toBeNull()
    expect(a.projects).toEqual([])
    expect(a.leadRunId).toBeNull()
    expect(a.runId).toBe(RUN_A)

    const r = mcall('report', { body: 'char report', assignmentId: a.id }, { runId: RUN_A }) as MgmtReport
    expect(r.body).toBe('char report')
    expect(r.assignmentId).toBe(a.id)
    expect(r.runId).toBe(RUN_A)
    expect(r.createdAt).toBeGreaterThan(0)
  })
})
