import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  KAskBodySchema,
  WorkItemStatusSchema,
  DurableWorkItemScopeSchema,
  KWorkItemCreateBodySchema,
  KWorkItemPatchBodySchema,
  type WorkItemStatus,
  type DurableWorkItemScope,
} from '@k/shared'
import { askK, ensureDefaultKThread, listKThreadTurns } from '../k-thread.js'
import { workItemsDb } from '../db.js'
import { rowToWorkItem } from '../mcp/k-store.js'

/** Hard cap on the durable work-items list read (mirrors the memory-gate route's 200). */
const DURABLE_LIST_LIMIT = 200

type Row = Record<string, unknown>

/**
 * The "talk to K" front door (P5.1c, D-023) + the durable work-items surface (A1):
 *   POST  /api/k/ask            — activate K on a message (warm or fresh), returns KAskResult
 *   GET   /api/k/thread         — the durable K thread + its turns (the source of truth)
 *   GET   /api/k/work-items     — the DURABLE operator-global work items (personal + org)
 *   POST  /api/k/work-items     — create a durable operator-global work item
 *   PATCH /api/k/work-items/:id — set a durable work item's status
 *
 * askK does the real ask work; the work-items handlers are thin adapters over the
 * kstore durable statements (workItemsDb) reusing rowToWorkItem as the one mapping
 * authority. All routes ride the same global Bearer auth hook (index.ts buildApp).
 */
export async function kRoutes(app: FastifyInstance) {
  // POST /api/k/ask — 400 bad body · 500 dispatch failure · 201 KAskResult.
  app.post('/api/k/ask', async (req, reply) => {
    const parsed = KAskBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    try {
      const result = await askK(parsed.data.message)
      return reply.status(201).send(result)
    } catch (e) {
      req.log.error(e)
      return reply.status(500).send({ error: 'k ask failed' })
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
      return reply.status(500).send({ error: 'k thread read failed' })
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
          if (!p.success) return reply.status(400).send({ error: 'invalid status' })
          status = p.data
        }
        let scope: DurableWorkItemScope | undefined
        if (req.query.scope !== undefined && req.query.scope !== '') {
          const p = DurableWorkItemScopeSchema.safeParse(req.query.scope)
          if (!p.success) return reply.status(400).send({ error: 'invalid scope' })
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
        return reply.status(500).send({ error: 'work items read failed' })
      }
    },
  )

  // POST /api/k/work-items — create a durable operator-global item. runId is NULL
  // (operator-created, no run provenance); status starts 'open'. 400 on a bad body.
  app.post('/api/k/work-items', async (req, reply) => {
    const parsed = KWorkItemCreateBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
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
      return reply.status(500).send({ error: 'work item create failed' })
    }
  })

  // PATCH /api/k/work-items/:id — set a durable item's status (title/body kept). The
  // durable-only fetch means run-scoped and project rows are NOT reachable here (404).
  app.patch<{ Params: { id: string } }>('/api/k/work-items/:id', async (req, reply) => {
    const parsed = KWorkItemPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    try {
      const existing = workItemsDb.getWorkItemDurable.get(req.params.id) as Row | undefined
      if (!existing) return reply.status(404).send({ error: 'not found' })
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
      return reply.status(500).send({ error: 'work item update failed' })
    }
  })
}
