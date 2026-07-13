import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  KAskBodySchema,
  KUndoBodySchema,
  KThreadCreateBodySchema,
  KThreadPatchBodySchema,
  WorkItemStatusSchema,
  DurableWorkItemScopeSchema,
  KWorkItemCreateBodySchema,
  KWorkItemPatchBodySchema,
  isKnownModel,
  type WorkItemStatus,
  type DurableWorkItemScope,
} from '@k/shared'
import {
  askK,
  undoK,
  getKThread,
  createKThread,
  rowToKThread,
  listKThreadTurns,
  KThreadNotFoundError,
} from '../k-thread.js'
import { BudgetCapError } from '../budget-governor.js'
import { workItemsDb, logisticsDb, runsDb, kThreadsDb } from '../db.js'
import { isTerminalRunStatus } from '../run-lifecycle.js'
import { rowToWorkItem } from '../mcp/k-store.js'
import { rowToNote, rowToCalendarEvent, rowToReminder } from '../mcp/logistics.js'
import { sendError, sendZodError } from './http-errors.js'

/** Hard cap on the durable work-items list read (mirrors the memory-gate route's 200). */
const DURABLE_LIST_LIMIT = 200

/** Cap on each K-home glance read (notes / events / reminders) — a card, not a browser. */
const GLANCE_LIST_LIMIT = 20

type Row = Record<string, unknown>

/**
 * The "talk to K" front door (P5.1c, D-023) + multi-thread K (UI Simplification) +
 * the durable work-items surface (A1) + the K-home glance reads (C2):
 *   POST  /api/k/ask            — activate K on a message (warm or fresh); accepts an
 *                                  optional threadId (404 unknown); returns KAskResult
 *   GET   /api/k/threads        — list threads (?archived=1 includes archived), newest first
 *   GET   /api/k/threads/:id    — a thread + its turns, oldest-first (404 unknown)
 *   POST  /api/k/threads        — create an empty thread (title backfilled on first ask)
 *   PATCH /api/k/threads/:id    — rename and/or archive/unarchive (404 unknown)
 *   DELETE /api/k/threads/:id   — delete a thread + its turns (404 unknown; 409 while its
 *                                  active run is non-terminal)
 *   GET   /api/k/work-items     — the DURABLE operator-global work items (personal + org)
 *   POST  /api/k/work-items     — create a durable operator-global work item
 *   PATCH /api/k/work-items/:id — set a durable work item's status
 *   DELETE /api/k/work-items/:id — delete a durable operator-global work item
 *   GET   /api/k/notes          — the most recent logistics notes (K-home Notes card)
 *   GET   /api/k/schedule       — upcoming events + pending reminders (Schedule card)
 *
 * askK does the real ask work; the work-items/notes/schedule handlers are thin
 * adapters over the durable statements (workItemsDb / logisticsDb) reusing
 * rowToWorkItem / rowToNote / rowToCalendarEvent / rowToReminder as the one mapping
 * authority. All routes ride the same global Bearer auth hook (index.ts buildApp).
 */
export async function kRoutes(app: FastifyInstance) {
  // POST /api/k/ask — 400 bad body/unknown model · 500 dispatch failure · 201 KAskResult.
  app.post('/api/k/ask', async (req, reply) => {
    const parsed = KAskBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    // An explicit model override must be a known Claude model id — the same gate
    // PATCH /api/orchestrators/:id applies to a profile's defaultModel.
    if (parsed.data.model !== undefined && !isKnownModel(parsed.data.model)) {
      return sendError(reply, 400, 'unknown model')
    }
    try {
      const result = await askK(parsed.data.message, {
        forceRoute: parsed.data.forceRoute,
        model: parsed.data.model,
        threadId: parsed.data.threadId,
      })
      return reply.status(201).send(result)
    } catch (e) {
      if (e instanceof KThreadNotFoundError) return sendError(reply, 404, 'thread not found')
      // E-17: a capped operator→Chief delegation is a transient, operator-resolvable state,
      // not a server fault — map it to a clean 429 (the explanatory K turn is already
      // persisted on the thread for the chat view), never an opaque 500.
      if (e instanceof BudgetCapError) {
        return reply.status(429).send({ error: e.message, scope: e.scope, capUsd: e.capUsd, spentUsd: e.spentUsd })
      }
      req.log.error(e)
      return sendError(reply, 500, 'k ask failed')
    }
  })

  // POST /api/k/undo — undo a just-started K ask (F-060): kill the run AND remove the
  // dangling turns it appended so the undone message is never replayed. 400 bad body ·
  // 404 unknown run · 200 { undone:true }. The existence guard mirrors /runs/:id/kill so
  // undoing an unknown id is a clear 404, not a silent success.
  app.post('/api/k/undo', async (req, reply) => {
    const parsed = KUndoBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    if (!runsDb.getRun.get(parsed.data.runId)) return sendError(reply, 404, 'not found')
    try {
      undoK(parsed.data.runId)
      return reply.send({ undone: true })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'k undo failed')
    }
  })

  // GET /api/k/threads?archived=1 — list threads, newest-updated first
  // (kThreadsDb.listThreads orders by updated_at DESC); default excludes archived
  // threads. Each row carries a snippet/lastTurnAt preview (latest turn) so a
  // thread-list UI never needs a per-row turns fetch just to render one.
  app.get<{ Querystring: { archived?: string } }>('/api/k/threads', async (req, reply) => {
    try {
      const includeArchived = req.query.archived === '1'
      const rows = kThreadsDb.listThreads.all() as Row[]
      const threads = rows
        .filter(r => includeArchived || r.archived_at == null)
        .map(r => ({
          ...rowToKThread(r),
          snippet: (r.snippet as string | null) ?? null,
          lastTurnAt: (r.last_turn_at as number | null) ?? null,
        }))
      return reply.send({ threads })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'threads read failed')
    }
  })

  // GET /api/k/threads/:id — a single thread + its turns, oldest-first. 404 unknown id.
  app.get<{ Params: { id: string } }>('/api/k/threads/:id', async (req, reply) => {
    try {
      const thread = getKThread(req.params.id)
      if (!thread) return sendError(reply, 404, 'not found')
      return reply.send({ thread, turns: listKThreadTurns(req.params.id) })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'thread read failed')
    }
  })

  // POST /api/k/threads — create an empty thread (title null; askK backfills it
  // from the operator's first message on that thread). 201 KThread.
  app.post('/api/k/threads', async (req, reply) => {
    const parsed = KThreadCreateBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      return reply.status(201).send(createKThread())
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'thread create failed')
    }
  })

  // PATCH /api/k/threads/:id — rename and/or archive/unarchive. F-022 ordering:
  // body validated FIRST (400), THEN existence checked (404). 200 KThread.
  app.patch<{ Params: { id: string } }>('/api/k/threads/:id', async (req, reply) => {
    const parsed = KThreadPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const { id } = req.params
      if (!getKThread(id)) return sendError(reply, 404, 'not found')
      if (parsed.data.title !== undefined) kThreadsDb.setThreadTitle.run(parsed.data.title, Date.now(), id)
      if (parsed.data.archived !== undefined) {
        kThreadsDb.setThreadArchived.run(parsed.data.archived ? Date.now() : null, Date.now(), id)
      }
      return reply.send(getKThread(id))
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'thread update failed')
    }
  })

  // DELETE /api/k/threads/:id — 404 unknown · 409 while the thread's active run is
  // still non-terminal (killing the thread out from under a live run would strand
  // it) · 204 on success. k_thread_turns cascades via FK ON DELETE CASCADE.
  app.delete<{ Params: { id: string } }>('/api/k/threads/:id', async (req, reply) => {
    try {
      const { id } = req.params
      const thread = getKThread(id)
      if (!thread) return sendError(reply, 404, 'not found')
      if (thread.activeRunId) {
        const run = runsDb.getRun.get(thread.activeRunId) as { status?: string } | undefined
        if (run && !isTerminalRunStatus(run.status)) return sendError(reply, 409, 'thread has a live run')
      }
      kThreadsDb.deleteThread.run(id) // turns cascade via FK ON DELETE CASCADE
      return reply.status(204).send()
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'thread delete failed')
    }
  })

  // GET /api/k/work-items?status=&scope= — the durable (personal + org) store, newest
  // first. Optional ?status / ?scope validated at the boundary (400 on a bad value).
  // Sends the bare array (matches routes/memory.ts). Run/project rows are NEVER here.
  app.get<{ Querystring: { status?: string; scope?: string } }>(
    '/api/k/work-items',
    async (req, reply) => {
      try {
        let status: WorkItemStatus | undefined
        if (req.query.status !== undefined && req.query.status !== '') {
          const p = WorkItemStatusSchema.safeParse(req.query.status)
          if (!p.success) return sendError(reply, 400, 'invalid status')
          status = p.data
        }
        let scope: DurableWorkItemScope | undefined
        if (req.query.scope !== undefined && req.query.scope !== '') {
          const p = DurableWorkItemScopeSchema.safeParse(req.query.scope)
          if (!p.success) return sendError(reply, 400, 'invalid scope')
          scope = p.data
        }
        let rows: Row[]
        if (scope !== undefined && status !== undefined) {
          rows = workItemsDb.listWorkItemsByScopeStatus.all(scope, status, DURABLE_LIST_LIMIT) as Row[]
        } else if (scope !== undefined) {
          rows = workItemsDb.listWorkItemsByScope.all(scope, DURABLE_LIST_LIMIT) as Row[]
        } else if (status !== undefined) {
          rows = workItemsDb.listDurableWorkItemsByStatus.all(status, DURABLE_LIST_LIMIT) as Row[]
        } else {
          rows = workItemsDb.listDurableWorkItems.all(DURABLE_LIST_LIMIT) as Row[]
        }
        return reply.send(rows.map(rowToWorkItem))
      } catch (e) {
        req.log.error(e)
        return sendError(reply, 500, 'work items read failed')
      }
    },
  )

  // POST /api/k/work-items — create a durable operator-global item. runId is NULL
  // (operator-created, no run provenance); status starts 'open'. 400 on a bad body.
  app.post('/api/k/work-items', async (req, reply) => {
    const parsed = KWorkItemCreateBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const now = Date.now()
      const id = randomUUID()
      workItemsDb.insertWorkItem.run({
        id,
        runId: null,
        title: parsed.data.title,
        body: parsed.data.body ?? null,
        status: 'open',
        scope: parsed.data.scope,
        createdAt: now,
        updatedAt: now,
      })
      return reply.status(201).send(rowToWorkItem(workItemsDb.getWorkItem.get(id) as Row))
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'work item create failed')
    }
  })

  // PATCH /api/k/work-items/:id — set a durable item's status (title/body kept). The
  // durable-only fetch means run-scoped and project rows are NOT reachable here (404).
  app.patch<{ Params: { id: string } }>('/api/k/work-items/:id', async (req, reply) => {
    const parsed = KWorkItemPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const existing = workItemsDb.getWorkItemDurable.get(req.params.id) as Row | undefined
      if (!existing) return sendError(reply, 404, 'not found')
      const cur = rowToWorkItem(existing)
      workItemsDb.updateWorkItem.run({
        id: req.params.id,
        title: cur.title,
        body: cur.body,
        status: parsed.data.status,
        updatedAt: Date.now(),
      })
      return reply.send(rowToWorkItem(workItemsDb.getWorkItemDurable.get(req.params.id) as Row))
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'work item update failed')
    }
  })

  // DELETE /api/k/work-items/:id — remove a durable operator-global item (204 no content).
  // Same durable-only scope guard as the PATCH (F-019): the delete statement matches only
  // scope IN ('personal','org'), so a run-scoped kstore ticket or a project row is unreachable
  // (0 rows changed → 404) — a run can never delete another surface's items through here. A
  // second delete of the same id also 404s (already gone).
  app.delete<{ Params: { id: string } }>('/api/k/work-items/:id', async (req, reply) => {
    try {
      const { changes } = workItemsDb.deleteWorkItemDurable.run(req.params.id)
      if (changes === 0) return sendError(reply, 404, 'not found')
      return reply.status(204).send()
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'work item delete failed')
    }
  })

  // GET /api/k/notes — the most recent notes (newest first, bounded), the K-home
  // Notes card's read. Bare array (mirrors the work-items list shape).
  app.get('/api/k/notes', async (req, reply) => {
    try {
      const rows = logisticsDb.listNotes.all(GLANCE_LIST_LIMIT) as Row[]
      return reply.send(rows.map(rowToNote))
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'notes read failed')
    }
  })

  // GET /api/k/schedule — the KSchedule payload for the K-home Schedule card:
  // upcoming events (startsAt >= now, soonest first) + 'pending' reminders soonest
  // first INCLUDING overdue ones — an overdue reminder is the most important thing
  // to show, not something to window away.
  app.get('/api/k/schedule', async (req, reply) => {
    try {
      const events = (
        logisticsDb.listEvents.all(Date.now(), Number.MAX_SAFE_INTEGER, GLANCE_LIST_LIMIT) as Row[]
      ).map(rowToCalendarEvent)
      const reminders = (
        logisticsDb.listRemindersByStatus.all('pending', GLANCE_LIST_LIMIT) as Row[]
      ).map(rowToReminder)
      return reply.send({ events, reminders })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'schedule read failed')
    }
  })
}
