import type { FastifyInstance } from 'fastify'
import { KAskBodySchema } from '@k/shared'
import { askK, ensureDefaultKThread, listKThreadTurns } from '../k-thread.js'

/**
 * The "talk to K" front door (P5.1c, D-023):
 *   POST /api/k/ask     — activate K on a message (warm or fresh), returns KAskResult
 *   GET  /api/k/thread  — the durable K thread + its turns (the source of truth)
 *
 * askK does the real work (durable turn, warm-vs-fresh, streaming over the existing
 * supervisor/EventBus/WS wire); these handlers only validate + shape the response.
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
}
