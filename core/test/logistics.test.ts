/**
 * logistics store-layer units (P5.1a).
 *
 * Exercises the SDK-free tool handlers in core/src/mcp/logistics.ts directly
 * through the `logisticsTools` registry, against the real DB singleton with run
 * fixtures. Covers notes / calendar-events / reminders CRUD, the K_RUN_ID→owner
 * resolution on INSERT (bogus run degrades to a null owner, no FK error), the
 * from/to event window filter, and — post-A1 — the OPERATOR-DURABLE model: the
 * store is operator-global (single operator), so any session may list/update any
 * row; run_id is provenance only. The MCP transport glue (logistics-server.ts) is
 * intentionally not unit-tested here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { logisticsTools, LogisticsError, type LogisticsContext } from '../src/mcp/logistics.js'
import type { Note, CalendarEvent, Reminder } from '@k/shared'

// ── fixtures: a project + two runs (owner + a second run) ─────────────────────
const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()

/** Invoke a logistics tool by name through the registry (as the server would). */
function call(name: string, args: unknown, ctx: LogisticsContext): unknown {
  const tool = logisticsTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such logistics tool: ${name}`)
  return tool.handler(args, ctx)
}

const ctxA: LogisticsContext = { runId: RUN_A }
const ctxB: LogisticsContext = { runId: RUN_B }
const bogusCtx: LogisticsContext = { runId: uuid() } // K_RUN_ID with no matching runs row
const noneCtx: LogisticsContext = { runId: null }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID,
    name: `logistics-test-${PROJECT_ID.slice(0, 8)}`,
    localPath: '/tmp/logistics-test',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id,
      prompt: 'logistics fixture',
      cwd: '/tmp/logistics-test',
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
})

afterAll(() => {
  db.prepare('DELETE FROM logistics_notes WHERE run_id IN (?, ?) OR run_id IS NULL').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_events WHERE run_id IN (?, ?) OR run_id IS NULL').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM logistics_reminders WHERE run_id IN (?, ?) OR run_id IS NULL').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('logistics: notes', () => {
  it('note_add persists a run-owned note (done=false); note_list finds it', () => {
    const note = call('note_add', { body: 'buy milk' }, ctxA) as Note
    expect(note.body).toBe('buy milk')
    expect(note.done).toBe(false)
    expect(note.runId).toBe(RUN_A)
    expect(note.createdAt).toBeGreaterThan(0)

    const all = call('note_list', {}, ctxA) as Note[]
    expect(all.some(n => n.id === note.id)).toBe(true)
  })

  it('note_update flips done and edits body; done filter narrows note_list', () => {
    const note = call('note_add', { body: 'draft email' }, ctxA) as Note

    const updated = call('note_update', { id: note.id, done: true, body: 'draft + send email' }, ctxA) as Note
    expect(updated.done).toBe(true)
    expect(updated.body).toBe('draft + send email')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(note.updatedAt)

    const done = call('note_list', { done: true }, ctxA) as Note[]
    expect(done.some(n => n.id === note.id)).toBe(true)
    const open = call('note_list', { done: false }, ctxA) as Note[]
    expect(open.some(n => n.id === note.id)).toBe(false)
  })

  it('note_update rejects an empty patch (LogisticsError) and an unknown id', () => {
    const note = call('note_add', { body: 'guard' }, ctxA) as Note
    expect(() => call('note_update', { id: note.id }, ctxA)).toThrow(LogisticsError)
    expect(() => call('note_update', { id: uuid(), done: true }, ctxA)).toThrow(LogisticsError)
  })

  it('note_add rejects an empty body (zod boundary)', () => {
    expect(() => call('note_add', { body: '' }, ctxA)).toThrow()
  })

  it('a bogus K_RUN_ID degrades to a null owner on insert (no FK error); the row is still durable', () => {
    const note = call('note_add', { body: 'no real run' }, bogusCtx) as Note
    expect(note.runId).toBeNull()
    // durable/operator-global: any session lists it — the null-owner ctx AND a real run.
    const seen = call('note_list', {}, noneCtx) as Note[]
    expect(seen.some(n => n.id === note.id)).toBe(true)
    const alsoSeen = call('note_list', {}, ctxA) as Note[]
    expect(alsoSeen.some(n => n.id === note.id)).toBe(true)
  })
})

describe('logistics: calendar events', () => {
  it('event_add stores startsAt; endsAt/location round-trip as null when omitted', () => {
    const ev = call('event_add', { title: 'standup', startsAt: 1000 }, ctxA) as CalendarEvent
    expect(ev.title).toBe('standup')
    expect(ev.startsAt).toBe(1000)
    expect(ev.endsAt).toBeNull()
    expect(ev.location).toBeNull()
    expect(ev.runId).toBe(RUN_A)

    const full = call(
      'event_add',
      { title: 'review', startsAt: 2000, endsAt: 2600, location: 'room 2' },
      ctxA,
    ) as CalendarEvent
    expect(full.endsAt).toBe(2600)
    expect(full.location).toBe('room 2')
  })

  it('event_list returns soonest-first and honours the from/to startsAt window', () => {
    const early = call('event_add', { title: 'w-early', startsAt: 100 }, ctxB) as CalendarEvent
    const mid = call('event_add', { title: 'w-mid', startsAt: 500 }, ctxB) as CalendarEvent
    const late = call('event_add', { title: 'w-late', startsAt: 900 }, ctxB) as CalendarEvent

    const windowed = call('event_list', { from: 400, to: 600 }, ctxB) as CalendarEvent[]
    const ids = windowed.map(e => e.id)
    expect(ids).toContain(mid.id)
    expect(ids).not.toContain(early.id)
    expect(ids).not.toContain(late.id)

    // regression: the from/to window is applied IN SQL before the LIMIT, so a
    // `from` bound with a tight limit still returns the earliest IN-WINDOW event
    // — never dropping it behind earlier out-of-window rows the LIMIT would keep.
    const capped = call('event_list', { from: 400, limit: 1 }, ctxB) as CalendarEvent[]
    expect(capped.map(e => e.id)).toEqual([mid.id])

    const all = call('event_list', {}, ctxB) as CalendarEvent[]
    const startsAts = all.filter(e => [early.id, mid.id, late.id].includes(e.id)).map(e => e.startsAt)
    // ascending order preserved
    expect(startsAts).toEqual([...startsAts].sort((a, b) => a - b))
  })

  it('event_update edits fields; requires ≥1 field; unknown id is not found', () => {
    const ev = call('event_add', { title: 'move me', startsAt: 10 }, ctxA) as CalendarEvent
    const moved = call('event_update', { id: ev.id, startsAt: 42, location: 'here' }, ctxA) as CalendarEvent
    expect(moved.startsAt).toBe(42)
    expect(moved.location).toBe('here')
    expect(moved.title).toBe('move me') // untouched

    expect(() => call('event_update', { id: ev.id }, ctxA)).toThrow(LogisticsError)
    expect(() => call('event_update', { id: uuid(), title: 'x' }, ctxA)).toThrow(LogisticsError)
  })
})

describe('logistics: reminders', () => {
  it('reminder_add lands pending; reminder_list by status; reminder_update flips status', () => {
    const rem = call('reminder_add', { text: 'call dentist', remindAt: 12345 }, ctxA) as Reminder
    expect(rem.status).toBe('pending')
    expect(rem.remindAt).toBe(12345)
    expect(rem.runId).toBe(RUN_A)

    const pending = call('reminder_list', { status: 'pending' }, ctxA) as Reminder[]
    expect(pending.some(r => r.id === rem.id)).toBe(true)

    const done = call('reminder_update', { id: rem.id, status: 'done' }, ctxA) as Reminder
    expect(done.status).toBe('done')
    const cancelled = call('reminder_add', { text: 'skip', remindAt: 1 }, ctxA) as Reminder
    const c2 = call('reminder_update', { id: cancelled.id, status: 'cancelled' }, ctxA) as Reminder
    expect(c2.status).toBe('cancelled')

    const stillPending = call('reminder_list', { status: 'pending' }, ctxA) as Reminder[]
    expect(stillPending.some(r => r.id === rem.id)).toBe(false)
  })

  it('reminder_update rejects an unknown id', () => {
    expect(() => call('reminder_update', { id: uuid(), status: 'done' }, ctxA)).toThrow(LogisticsError)
  })
})

// A1: the logistics store is OPERATOR-DURABLE (single operator) — run B CAN list and
// mutate a row run A created (rows persist across sessions/runs; run_id is provenance).
// This is the intended flip from the pre-A1 run-scoped isolation.
describe('logistics: operator-durable (any run can read + mutate any row)', () => {
  it('RUN_B lists and mutates RUN_A\'s note', () => {
    const mine = call('note_add', { body: 'A-owned note' }, ctxA) as Note
    const bList = call('note_list', {}, ctxB) as Note[]
    expect(bList.some(n => n.id === mine.id)).toBe(true)
    const byB = call('note_update', { id: mine.id, done: true }, ctxB) as Note
    expect(byB.done).toBe(true)
    // provenance unchanged: the row still records RUN_A as its creator.
    expect(byB.runId).toBe(RUN_A)
  })

  it('RUN_B lists and mutates RUN_A\'s event', () => {
    const mine = call('event_add', { title: 'A-owned event', startsAt: 7 }, ctxA) as CalendarEvent
    const bList = call('event_list', {}, ctxB) as CalendarEvent[]
    expect(bList.some(e => e.id === mine.id)).toBe(true)
    const byB = call('event_update', { id: mine.id, title: 'kept' }, ctxB) as CalendarEvent
    expect(byB.title).toBe('kept')
    expect(byB.runId).toBe(RUN_A)
  })

  it('RUN_B lists and mutates RUN_A\'s reminder', () => {
    const mine = call('reminder_add', { text: 'A-owned reminder', remindAt: 9 }, ctxA) as Reminder
    const bList = call('reminder_list', {}, ctxB) as Reminder[]
    expect(bList.some(r => r.id === mine.id)).toBe(true)
    const byB = call('reminder_update', { id: mine.id, status: 'cancelled' }, ctxB) as Reminder
    expect(byB.status).toBe('cancelled')
    expect(byB.runId).toBe(RUN_A)
  })

  it('an unknown id is still not found (LogisticsError)', () => {
    expect(() => call('note_update', { id: uuid(), done: true }, ctxB)).toThrow(LogisticsError)
    expect(() => call('event_update', { id: uuid(), title: 'x' }, ctxB)).toThrow(LogisticsError)
    expect(() => call('reminder_update', { id: uuid(), status: 'done' }, ctxB)).toThrow(LogisticsError)
  })
})
