import type { FastifyInstance } from 'fastify'
import { NotificationEventKeySchema, UpdateNotificationRuleBodySchema, type Notification, type NotificationRule } from '@k/shared'
import { notificationsDb } from '../db.js'
import { sendError, sendZodError } from './http-errors.js'

function rowToNotification(r: Record<string, unknown>): Notification {
  return {
    id: String(r.id),
    eventKey: r.event_key as Notification['eventKey'],
    title: String(r.title),
    body: r.body != null ? String(r.body) : null,
    runId: r.run_id != null ? String(r.run_id) : null,
    projectId: r.project_id != null ? String(r.project_id) : null,
    createdAt: Number(r.created_at),
    readAt: r.read_at != null ? Number(r.read_at) : null,
  }
}

function rowToRule(r: Record<string, unknown>): NotificationRule {
  return { eventKey: r.event_key as NotificationRule['eventKey'], inapp: r.inapp === 1, browser: r.browser === 1 }
}

/** E-19 notification center + rules routes. */
export async function notificationsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/api/notifications', async (req, reply) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200)
    const rows = notificationsDb.listNotifications.all(limit) as Record<string, unknown>[]
    const unread = (notificationsDb.countUnreadNotifications.get() as { n: number }).n
    return reply.send({ notifications: rows.map(rowToNotification), unread })
  })

  // Stamp-once (read_at IS NULL guard): a re-POST reads as 404 — the row is no
  // longer an unread notification.
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req, reply) => {
    if (notificationsDb.markNotificationRead.run(Date.now(), req.params.id).changes === 0) {
      return sendError(reply, 404, 'not found (or already read)')
    }
    return reply.status(204).send()
  })

  app.post('/api/notifications/read-all', async (_req, reply) => {
    const res = notificationsDb.markAllNotificationsRead.run(Date.now())
    return reply.send({ marked: res.changes })
  })

  app.get('/api/notifications/rules', async (_req, reply) => {
    const rows = notificationsDb.listNotificationRules.all() as Record<string, unknown>[]
    return reply.send(rows.map(rowToRule))
  })

  app.patch<{ Params: { eventKey: string } }>('/api/notifications/rules/:eventKey', async (req, reply) => {
    const key = NotificationEventKeySchema.safeParse(req.params.eventKey)
    if (!key.success) return sendError(reply, 400, 'unknown event key')
    const parsed = UpdateNotificationRuleBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const current = notificationsDb.getNotificationRule.get(key.data) as Record<string, unknown> | undefined
    const next = {
      eventKey: key.data,
      inapp: (parsed.data.inapp ?? (current ? current.inapp === 1 : true)) ? 1 : 0,
      browser: (parsed.data.browser ?? (current ? current.browser === 1 : false)) ? 1 : 0,
    }
    notificationsDb.upsertNotificationRule.run(next)
    return reply.send(rowToRule(notificationsDb.getNotificationRule.get(key.data) as Record<string, unknown>))
  })
}
