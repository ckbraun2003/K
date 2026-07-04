import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  KAskBodySchema,
  WorkItemStatusSchema,
  DurableWorkItemScopeSchema,
  KWorkItemCreateBodySchema,
  KWorkItemPatchBodySchema,
  isKnownModel,
  type WorkItemStatus,
  type DurableWorkItemScope,
} from '@k/shared'
import { askK, ensureDefaultKThread, listKThreadTurns } from '../k-thread.js'
import { workItemsDb, logisticsDb } from '../db.js'
import { rowToWorkItem } from '../mcp/k-store.js'
import { rowToNote, rowToCalendarEvent, rowToReminder } from '../mcp/logistics.js'
import { sendError, sendZodError } from './http-errors.js'

/** Hard cap on the durable work-items list read (mirrors the memory-gate route's 200). */
const DURABLE_LIST_LIMIT = 200

/** Cap on each K-home glance read (notes / events / reminders) — a card, not a browser. */
const GLANCE_LIST_LIMIT = 20

type Row = Record<string, unknown>

/**
 * The "talk to K" front door (P5.1c, D-023) + the durable work-items surface (A1)
 * + the K-home glance reads (C2):
 *   POST  /api/k/ask            — activate K on a message (warm or fresh), returns KAskResult
 *   GET   /api/k/thread         — the durable K thread + its turns (the source of truth)
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
      })
      return reply.status(201).send(result)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'k ask failed')
    }
  })

  // GET /api/k/thread — the durable thread + turns (survives reload). Wrapped like
  // the POST handler so a DB fault surfaces as a typed 500, not a raw stack.
  app.get('/api/k/thread', async (req, reply) => {
    try {
      const thread = ensureDefaultKThread()
      const turns = listKThreadTurns(thread.id)
      return reply.send({ thread, turns })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'k thread read failed')
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
