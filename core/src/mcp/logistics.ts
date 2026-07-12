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
 * handler) plus a `ctx` with the injected K_RUN_ID. The store is OPERATOR-DURABLE
 * (single operator): rows persist across sessions and runs, so any session may list
 * or update them; run_id is recorded on INSERT as PROVENANCE only, never as an access
 * filter.
 */
import { randomUUID } from 'node:crypto'
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import {
  ReminderStatusSchema,
  type Note,
  type CalendarEvent,
  type Reminder,
  type UserMemory,
} from '@k/shared'
import { logisticsDb, runsDb, memoriesDb, kThreadsDb, notificationsDb } from '../db.js'
import { rowToMemory } from '../routes/memories.js'

/** Per-call context the server injects. `runId` is the managed run (K_RUN_ID). */
export interface LogisticsContext {
  runId: string | null
}

/** Thrown for genuine caller errors (bad id, empty patch); the glue maps it to isError. */
export class LogisticsError extends Error {}

type Row = Record<string, unknown>
const asNum = (v: unknown): number => Number(v)
const asStrOrNull = (v: unknown): string | null => (v == null ? null : String(v))

// The row→type mappers are exported so the K-home HTTP surface (routes/k.ts
// notes/schedule reads) reuses this ONE mapping authority — mirroring how
// routes/k.ts already reuses rowToWorkItem from k-store.ts.
export function rowToNote(r: Row): Note {
  return {
    id: String(r.id),
    runId: asStrOrNull(r.run_id),
    body: String(r.body),
    done: Number(r.done) !== 0,
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
  }
}

export function rowToCalendarEvent(r: Row): CalendarEvent {
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

export function rowToReminder(r: Row): Reminder {
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
function noteList(args: unknown): Note[] {
  const a = z.object(NoteListInput).parse(args ?? {})
  const limit = a.limit ?? 50
  // Operator-global — notes are durable across sessions/runs (single operator).
  const rows = (
    a.done !== undefined
      ? logisticsDb.listNotesByDone.all(a.done ? 1 : 0, limit)
      : logisticsDb.listNotes.all(limit)
  ) as Row[]
  return rows.map(rowToNote)
}

const NoteUpdateInput = {
  id: z.string().min(1).max(100),
  body: z.string().min(1).max(20_000).optional(),
  done: z.boolean().optional(),
}
function noteUpdate(args: unknown): Note {
  const a = z.object(NoteUpdateInput).parse(args ?? {})
  if (a.body === undefined && a.done === undefined) {
    throw new LogisticsError('note_update needs at least one of: body, done.')
  }
  // Durable: any session may update the operator's note. Fetch by plain id.
  const existing = logisticsDb.getNote.get(a.id) as Row | undefined
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
function eventList(args: unknown): CalendarEvent[] {
  const a = z.object(EventListInput).parse(args ?? {})
  const limit = a.limit ?? 50
  // Operator-global, soonest-first, with the optional from/to window pushed INTO SQL so
  // the LIMIT caps the WINDOWED set — an omitted bound widens to the int extremes.
  const from = a.from ?? Number.MIN_SAFE_INTEGER
  const to = a.to ?? Number.MAX_SAFE_INTEGER
  const rows = logisticsDb.listEvents.all(from, to, limit) as Row[]
  return rows.map(rowToCalendarEvent)
}

const EventUpdateInput = {
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500).optional(),
  startsAt: z.number().int().optional(),
  endsAt: z.number().int().optional(),
  location: z.string().max(500).optional(),
}
function eventUpdate(args: unknown): CalendarEvent {
  const a = z.object(EventUpdateInput).parse(args ?? {})
  if (
    a.title === undefined &&
    a.startsAt === undefined &&
    a.endsAt === undefined &&
    a.location === undefined
  ) {
    throw new LogisticsError('event_update needs at least one of: title, startsAt, endsAt, location.')
  }
  // Durable: any session may update the operator's event. Fetch by plain id.
  const existing = logisticsDb.getEvent.get(a.id) as Row | undefined
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
function reminderList(args: unknown): Reminder[] {
  const a = z.object(ReminderListInput).parse(args ?? {})
  const limit = a.limit ?? 50
  // Operator-global — reminders are durable across sessions/runs (single operator).
  const rows = (
    a.status
      ? logisticsDb.listRemindersByStatus.all(a.status, limit)
      : logisticsDb.listReminders.all(limit)
  ) as Row[]
  return rows.map(rowToReminder)
}

const ReminderUpdateInput = { id: z.string().min(1).max(100), status: ReminderStatusSchema }
function reminderUpdate(args: unknown): Reminder {
  const a = z.object(ReminderUpdateInput).parse(args ?? {})
  // Durable: any session may update the operator's reminder. Fetch by plain id.
  const existing = logisticsDb.getReminder.get(a.id) as Row | undefined
  if (!existing) throw new LogisticsError(`reminder "${a.id}" not found.`)
  logisticsDb.updateReminder.run({ id: a.id, status: a.status, updatedAt: Date.now() })
  return rowToReminder(logisticsDb.getReminder.get(a.id) as Row)
}

// ── handlers: operator memory ───────────────────────────────────────────────

const MemorySaveInput = { content: z.string().min(1).max(2000) }

/** K's durable memory of the operator (a TOOL, not a file — see routes/memories.ts
 *  for the operator-facing CRUD surface this shares with). `ctx` is unused here:
 *  this handler resolves K_RUN_ID straight from the process env (same value the
 *  server would have injected into `ctx.runId`) rather than trusting the caller's
 *  ctx object, since threadByActiveRun keys off the SAME env-sourced run id the
 *  rest of the run's identity is anchored to. */
function memorySave(args: unknown): UserMemory {
  const { content } = z.object(MemorySaveInput).parse(args)
  const now = Date.now()
  const runId = process.env.K_RUN_ID || null
  const threadRow = runId ? (kThreadsDb.threadByActiveRun.get(runId) as { id: string } | undefined) : undefined
  const id = `um-${uuid()}`
  memoriesDb.insertMemory.run({
    id,
    content,
    sourceThreadId: threadRow?.id ?? null,
    createdAt: now,
    updatedAt: now,
  })

  // Quiet operator notification — a DB insert only, mirroring notify.ts::fire's
  // INSERT shape and rule gate. This handler runs in the stdio MCP child process,
  // which cannot reach the web server's in-memory eventBus; the web picks the row
  // up via its existing notifications invalidation instead of a live broadcast.
  const ruleRow = notificationsDb.getNotificationRule.get('memory_saved') as
    | { inapp: number; browser: number }
    | undefined
  const inapp = ruleRow ? ruleRow.inapp === 1 : true // unseeded fallback: DEFAULT_RULES.memory_saved.inapp
  if (inapp) {
    notificationsDb.insertNotification.run({
      id: randomUUID(),
      eventKey: 'memory_saved',
      title: 'K remembered',
      body: content.slice(0, 140),
      runId: null,
      projectId: null,
      createdAt: now,
      readAt: null,
    })
  }

  return rowToMemory(memoriesDb.getMemory.get(id) as Row)
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
      "List recent logistics notes (durable — the operator's notes persist across sessions and runs), optionally filtered by done state. Returns an array of notes.",
    inputShape: NoteListInput,
    handler: noteList,
  },
  {
    name: 'note_update',
    description:
      'Update a note by id — edit its body and/or flip done. Notes are durable (updatable from any session). Returns the updated note.',
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
      "List the operator's calendar events (durable — persist across sessions and runs; soonest first), optionally within a from/to startsAt window. Returns an array of events.",
    inputShape: EventListInput,
    handler: eventList,
  },
  {
    name: 'event_update',
    description:
      'Update a calendar event by id — set title/startsAt/endsAt/location. Events are durable (updatable from any session). Returns the updated event.',
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
      "List the operator's reminders (durable — persist across sessions and runs), optionally filtered by status (pending | done | cancelled). Returns an array.",
    inputShape: ReminderListInput,
    handler: reminderList,
  },
  {
    name: 'reminder_update',
    description:
      'Update the status of a reminder by id (pending | done | cancelled). Reminders are durable (updatable from any session). Returns the updated reminder.',
    inputShape: ReminderUpdateInput,
    handler: reminderUpdate,
  },
  {
    name: 'memory_save',
    description:
      'Remember a durable fact or preference about your operator (a TOOL, not a file). Saves to the operator-visible memory store and quietly notifies them. Call it whenever the operator explicitly asks you to remember or save something about themselves, and when they reveal a lasting fact or preference worth keeping. Use for lasting facts, never transient task state.',
    inputShape: MemorySaveInput,
    handler: memorySave,
  },
]
