import type { FastifyInstance } from 'fastify'
import { randomUUID as uuid } from 'node:crypto'
import { memoriesDb } from '../db.js'
import { UserMemoryCreateBodySchema, UserMemoryPatchBodySchema, type UserMemory } from '@k/shared'
import { sendError } from './http-errors.js'

export function rowToMemory(r: Record<string, unknown>): UserMemory {
  return {
    id: r.id as string,
    content: r.content as string,
    sourceThreadId: (r.source_thread_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }
}

export async function memoriesRoutes(app: FastifyInstance) {
  app.get('/api/memories', async () => ({
    memories: (memoriesDb.listMemories.all() as Array<Record<string, unknown>>).map(rowToMemory),
  }))

  app.post('/api/memories', async (req, reply) => {
    const parsed = UserMemoryCreateBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendError(reply, 400, 'bad body')
    const now = Date.now()
    const id = `um-${uuid()}`
    memoriesDb.insertMemory.run({ id, content: parsed.data.content, sourceThreadId: null, createdAt: now, updatedAt: now })
    return reply.code(201).send(rowToMemory(memoriesDb.getMemory.get(id) as Record<string, unknown>))
  })

  app.patch('/api/memories/:id', async (req, reply) => {
    const parsed = UserMemoryPatchBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendError(reply, 400, 'bad body')
    const { id } = req.params as { id: string }
    if (!memoriesDb.getMemory.get(id)) return sendError(reply, 404, 'not found')
    memoriesDb.updateMemory.run({ id, content: parsed.data.content, updatedAt: Date.now() })
    return rowToMemory(memoriesDb.getMemory.get(id) as Record<string, unknown>)
  })

  app.delete('/api/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!memoriesDb.getMemory.get(id)) return sendError(reply, 404, 'not found')
    memoriesDb.deleteMemory.run(id)
    return reply.code(204).send()
  })
}
