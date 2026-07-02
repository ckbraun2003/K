/**
 * A1 — logistics is operator-durable (single operator).
 *
 * A note/event/reminder created under run A is listed AND updatable from run B and
 * from a null-owner ctx (operator-global). Inserts still record run_id as provenance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { logisticsTools, type LogisticsContext } from '../src/mcp/logistics.js'
import type { Note, CalendarEvent, Reminder } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()

function call(name: string, args: unknown, ctx: LogisticsContext): unknown {
  const t = logisticsTools.find(x => x.name === name)
  if (!t) throw new Error(`no such logistics tool: ${name}`)
  return t.handler(args, ctx)
}
const ctxA: LogisticsContext = { runId: RUN_A }
const ctxB: LogisticsContext = { runId: RUN_B }
const noneCtx: LogisticsContext = { runId: null }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `a1-log-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/a1-log',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id, prompt: 'a1 log fixture', cwd: '/tmp/a1-log', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
  }
})

afterAll(() => {
  db.prepare('DELETE FROM logistics_notes WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_events WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_reminders WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('A1 logistics durable', () => {
  it('a note created in run A is listed + updatable from run B and from a null ctx', () => {
    const note = call('note_add', { body: 'durable note' }, ctxA) as Note
    expect(note.runId).toBe(RUN_A)

    expect((call('note_list', {}, ctxB) as Note[]).some(n => n.id === note.id)).toBe(true)
    expect((call('note_list', {}, noneCtx) as Note[]).some(n => n.id === note.id)).toBe(true)

    const byB = call('note_update', { id: note.id, done: true }, ctxB) as Note
    expect(byB.done).toBe(true)
    expect(byB.runId).toBe(RUN_A) // provenance preserved
    const byNull = call('note_update', { id: note.id, body: 'edited by null ctx' }, noneCtx) as Note
    expect(byNull.body).toBe('edited by null ctx')
  })

  it('an event created in run A is listed + updatable from run B and from a null ctx', () => {
    const ev = call('event_add', { title: 'durable event', startsAt: 5000 }, ctxA) as CalendarEvent
    expect(ev.runId).toBe(RUN_A)

    expect((call('event_list', {}, ctxB) as CalendarEvent[]).some(e => e.id === ev.id)).toBe(true)
    expect((call('event_list', {}, noneCtx) as CalendarEvent[]).some(e => e.id === ev.id)).toBe(true)

    const byB = call('event_update', { id: ev.id, location: 'moved by B' }, ctxB) as CalendarEvent
    expect(byB.location).toBe('moved by B')
    expect(byB.runId).toBe(RUN_A)
  })

  it('a reminder created in run A is listed + updatable from run B and from a null ctx', () => {
    const rem = call('reminder_add', { text: 'durable reminder', remindAt: 7000 }, ctxA) as Reminder
    expect(rem.runId).toBe(RUN_A)

    expect((call('reminder_list', {}, ctxB) as Reminder[]).some(r => r.id === rem.id)).toBe(true)
    expect((call('reminder_list', {}, noneCtx) as Reminder[]).some(r => r.id === rem.id)).toBe(true)

    const byB = call('reminder_update', { id: rem.id, status: 'done' }, ctxB) as Reminder
    expect(byB.status).toBe('done')
    expect(byB.runId).toBe(RUN_A)
  })
})
