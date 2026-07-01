/**
 * logistics — K's secretary-tier logistics working store behind the logistics
 * stdio MCP server.
 *
 * This module is the AUTHORITATIVE store logic for the logistics tools (notes,
 * calendar events, reminders — calendar/notes/scheduling). Like k-store.ts it is
 * deliberately FREE of any MCP-SDK or transport import so it can be:
 *   - unit-tested directly against the DB (see core/test/logistics.test.ts), and
 *   - reused by the stdio MCP server (logistics-server.ts).
 *
 * Logistics/memory is a TOOL, not a file, and this is STORAGE, not execution:
 * storing a calendar event here does NOT schedule it on any real calendar.
 *
 * Each tool carries its own zod input shape (authoritative validation lives in the
 * handler) plus a `ctx` with the injected K_RUN_ID. Every row is scoped to that
 * run, so one run can never read or mutate another run's logistics rows.
 */
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import {
  ReminderStatusSchema,
  type Note,
  type CalendarEvent,
  type Reminder,
} from '@k/shared'
import { logisticsDb, runsDb } from '../db.js'

/** Per-call context the server injects. `runId` is the managed run (K_RUN_ID). */
export interface LogisticsContext {
  runId: string | null
}

/** Thrown for genuine caller errors (bad id, empty patch); the glue maps it to isError. */
export class LogisticsError extends Error {}

type Row = Record<string, unknown>
const asNum = (v: unknown): number => Number(v)
const asStrOrNull = (v: unknown): string | null => (v == null ? null : String(v))

function rowToNote(r: Row): Note {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    body: String(r.body),
    done: Number(r.done) !== 0,
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

function rowToCalendarEvent(r: Row): CalendarEvent {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    title: String(r.title),
    startsAt: asNum(r.starts_at),
    endsAt: r.ends_at == null ? null : asNum(r.ends_at),
    location: asStrOrNull(r.location),
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

function rowToReminder(r: Row): Reminder {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    text: String(r.text),
    remindAt: asNum(r.remind_at),
    status: r.status as Reminder['status'],
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

/** Owner run id, but only if that run actually exists — guards the FK and the
 *  race where K_RUN_ID is set before/without a matching runs row. */
function resolveOwnerRunId(ctx: LogisticsContext): string | null {
  if (!ctx.runId) return null
  return runsDb.getRun.get(ctx.runId) ? ctx.runId : null
}

// ── handlers: notes ─────────────────────────────────────────────────────────

const NoteAddInput = { body: z.string().min(1).max(20_000) }
function noteAdd(args: unknown, ctx: LogisticsContext): Note {
  const a = z.object(NoteAddInput).parse(args ?? {})
  const now = Date.now()
  const id = uuid()
  logisticsDb.insertNote.run({
    id,
    runId: resolveOwnerRunId(ctx),
    body: a.body,
    done: 0,
    createdAt: now,
    updatedAt: now,
  })
  return rowToNote(logisticsDb.getNote.get(id) as Row)
}

const NoteListInput = {
  done: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}
function noteList(args: unknown, ctx: LogisticsContext): Note[] {
  const a = z.object(NoteListInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const limit = a.limit ?? 50
  // Scoped to the caller's run — a run never lists another run's notes.
  const rows = (
    a.done !== undefined
      ? logisticsDb.listNotesByRunDone.all(owner, a.done ? 1 : 0, limit)
      : logisticsDb.listNotesByRun.all(owner, limit)
  ) as Row[]
  return rows.map(rowToNote)
}

const NoteUpdateInput = {
  id: z.string().min(1).max(100),
  body: z.string().min(1).max(20_000).optional(),
  done: z.boolean().optional(),
}
function noteUpdate(args: unknown, ctx: LogisticsContext): Note {
  const a = z.object(NoteUpdateInput).parse(args ?? {})
  if (a.body === undefined && a.done === undefined) {
    throw new LogisticsError('note_update needs at least one of: body, done.')
  }
  // Ownership-scoped fetch: a note owned by another run reads as "not found".
  const existing = logisticsDb.getNoteOwned.get(a.id, resolveOwnerRunId(ctx)) as Row | undefined
  if (!existing) throw new LogisticsError(`note "${a.id}" not found.`)
  const cur = rowToNote(existing)
  logisticsDb.updateNote.run({
    id: a.id,
    body: a.body ?? cur.body,
    done: (a.done ?? cur.done) ? 1 : 0,
    updatedAt: Date.now(),
  })
  return rowToNote(logisticsDb.getNote.get(a.id) as Row)
}

// ── handlers: calendar events ───────────────────────────────────────────────

const EventAddInput = {
  title: z.string().min(1).max(500),
  startsAt: z.number().int(),
  endsAt: z.number().int().optional(),
  location: z.string().max(500).optional(),
}
function eventAdd(args: unknown, ctx: LogisticsContext): CalendarEvent {
  const a = z.object(EventAddInput).parse(args ?? {})
  const now = Date.now()
  const id = uuid()
  logisticsDb.insertEvent.run({
    id,
    runId: resolveOwnerRunId(ctx),
    title: a.title,
    startsAt: a.startsAt,
    endsAt: a.endsAt ?? null,
    location: a.location ?? null,
    createdAt: now,
    updatedAt: now,
  })
  return rowToCalendarEvent(logisticsDb.getEvent.get(id) as Row)
}

const EventListInput = {
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}
function eventList(args: unknown, ctx: LogisticsContext): CalendarEvent[] {
  const a = z.object(EventListInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const limit = a.limit ?? 50
  // Run-scoped, soonest-first, with the optional from/to window pushed INTO SQL so
  // the LIMIT caps the WINDOWED set — an omitted bound widens to the int extremes.
  const from = a.from ?? Number.MIN_SAFE_INTEGER
  const to = a.to ?? Number.MAX_SAFE_INTEGER
  const rows = logisticsDb.listEventsByRun.all(owner, from, to, limit) as Row[]
  return rows.map(rowToCalendarEvent)
}

const EventUpdateInput = {
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500).optional(),
  startsAt: z.number().int().optional(),
  endsAt: z.number().int().optional(),
  location: z.string().max(500).optional(),
}
function eventUpdate(args: unknown, ctx: LogisticsContext): CalendarEvent {
  const a = z.object(EventUpdateInput).parse(args ?? {})
  if (
    a.title === undefined &&
    a.startsAt === undefined &&
    a.endsAt === undefined &&
    a.location === undefined
  ) {
    throw new LogisticsError('event_update needs at least one of: title, startsAt, endsAt, location.')
  }
  // Ownership-scoped fetch: an event owned by another run reads as "not found".
  const existing = logisticsDb.getEventOwned.get(a.id, resolveOwnerRunId(ctx)) as Row | undefined
  if (!existing) throw new LogisticsError(`event "${a.id}" not found.`)
  const cur = rowToCalendarEvent(existing)
  logisticsDb.updateEvent.run({
    id: a.id,
    title: a.title ?? cur.title,
    startsAt: a.startsAt ?? cur.startsAt,
    endsAt: a.endsAt !== undefined ? a.endsAt : cur.endsAt,
    location: a.location !== undefined ? a.location : cur.location,
    updatedAt: Date.now(),
  })
  return rowToCalendarEvent(logisticsDb.getEvent.get(a.id) as Row)
}

// ── handlers: reminders ─────────────────────────────────────────────────────

const ReminderAddInput = { text: z.string().min(1).max(2_000), remindAt: z.number().int() }
function reminderAdd(args: unknown, ctx: LogisticsContext): Reminder {
  const a = z.object(ReminderAddInput).parse(args ?? {})
  const now = Date.now()
  const id = uuid()
  logisticsDb.insertReminder.run({
    id,
    runId: resolveOwnerRunId(ctx),
    text: a.text,
    remindAt: a.remindAt,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })
  return rowToReminder(logisticsDb.getReminder.get(id) as Row)
}

const ReminderListInput = {
  status: ReminderStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}
function reminderList(args: unknown, ctx: LogisticsContext): Reminder[] {
  const a = z.object(ReminderListInput).parse(args ?? {})
  const owner = resolveOwnerRunId(ctx)
  const limit = a.limit ?? 50
  // Scoped to the caller's run — a run only sees its own reminders.
  const rows = (
    a.status
      ? logisticsDb.listRemindersByRunStatus.all(owner, a.status, limit)
      : logisticsDb.listRemindersByRun.all(owner, limit)
  ) as Row[]
  return rows.map(rowToReminder)
}

const ReminderUpdateInput = { id: z.string().min(1).max(100), status: ReminderStatusSchema }
function reminderUpdate(args: unknown, ctx: LogisticsContext): Reminder {
  const a = z.object(ReminderUpdateInput).parse(args ?? {})
  // Ownership-scoped fetch: a reminder owned by another run reads as "not found".
  const existing = logisticsDb.getReminderOwned.get(a.id, resolveOwnerRunId(ctx)) as Row | undefined
  if (!existing) throw new LogisticsError(`reminder "${a.id}" not found.`)
  logisticsDb.updateReminder.run({ id: a.id, status: a.status, updatedAt: Date.now() })
  return rowToReminder(logisticsDb.getReminder.get(a.id) as Row)
}

// ── registry ────────────────────────────────────────────────────────────────

export interface LogisticsTool {
  name: string
  description: string
  /** Raw zod shape — advertised to MCP as the tool's input schema. */
  inputShape: z.ZodRawShape
  /** Authoritative handler. Validates `args` itself; throws LogisticsError on caller error. */
  handler: (args: unknown, ctx: LogisticsContext) => unknown
}

export const logisticsTools: LogisticsTool[] = [
  {
    name: 'note_add',
    description:
      'Add a note to K\'s logistics working store (a TOOL, not a file — storage, not execution). Returns the created note.',
    inputShape: NoteAddInput,
    handler: noteAdd,
  },
  {
    name: 'note_list',
    description:
      'List this run\'s recent logistics notes, optionally filtered by done state. Returns an array of notes.',
    inputShape: NoteListInput,
    handler: noteList,
  },
  {
    name: 'note_update',
    description:
      'Update one of this run\'s notes by id — edit its body and/or flip done. Returns the updated note.',
    inputShape: NoteUpdateInput,
    handler: noteUpdate,
  },
  {
    name: 'event_add',
    description:
      'Add a calendar event to the logistics store (storage only — this does NOT schedule it on any real calendar). Returns the created event.',
    inputShape: EventAddInput,
    handler: eventAdd,
  },
  {
    name: 'event_list',
    description:
      'List this run\'s calendar events (soonest first), optionally within a from/to startsAt window. Returns an array of events.',
    inputShape: EventListInput,
    handler: eventList,
  },
  {
    name: 'event_update',
    description:
      'Update one of this run\'s calendar events by id — set title/startsAt/endsAt/location. Returns the updated event.',
    inputShape: EventUpdateInput,
    handler: eventUpdate,
  },
  {
    name: 'reminder_add',
    description:
      'Add a reminder to the logistics store (storage only — K does not fire it). It lands pending. Returns the created reminder.',
    inputShape: ReminderAddInput,
    handler: reminderAdd,
  },
  {
    name: 'reminder_list',
    description:
      'List this run\'s reminders, optionally filtered by status (pending | done | cancelled). Returns an array.',
    inputShape: ReminderListInput,
    handler: reminderList,
  },
  {
    name: 'reminder_update',
    description:
      'Update the status of one of this run\'s reminders by id (pending | done | cancelled). Returns the updated reminder.',
    inputShape: ReminderUpdateInput,
    handler: reminderUpdate,
  },
]
