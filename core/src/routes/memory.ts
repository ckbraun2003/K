// P5.1b — HTTP surface for the OPERATOR GATE over pending agent-memory lessons (memory layer A,
// D-022/D-034). The kstore MCP `lesson_propose` tool writes a lesson as status='pending' (see
// mcp/k-store.ts::lessonPropose → agentMemoryDb.insertLesson); this route lets an operator LIST the
// pending queue (optionally by proposing profile) and APPROVE (pending→accepted) or REJECT
// (pending→rejected) each one. Business rules stay thin: validate at the boundary, shape JSON,
// map status codes — mirroring routes/evals.ts and routes/skills.ts.
//
// SEAMS: approve/reject flip the SAME agent_memory row the producer inserted (agentMemoryDb.getLesson
// + agentMemoryDb.updateLessonStatus operate by primary-key id), so an accepted lesson is durable and
// visible to the producer's own lesson_list — no shadow copy.
import type { FastifyInstance } from 'fastify'
import { LessonStatusSchema } from '@k/shared'
import { agentMemoryDb, agentProfilesDb } from '../db.js'

// The legal lifecycle states, sourced from the SAME shared enum the kstore producer validates
// against (LessonStatusSchema) so the two can never drift. Validated at the boundary so a bogus
// ?status can never reach the query as a live filter (400, typed error).
const LESSON_STATUSES = new Set<string>(LessonStatusSchema.options)

/** Shape one agent_memory row (optionally join-enriched with profile_name) for the API:
 *  snake→camel, null-sentinel (never `||`) for absent columns. Numbers via Number(), strings via
 *  String() when present — mirroring evals.ts::shapeRun / db.ts::rowToProjectTask. */
function rowToMemoryLesson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(r.id),
    runId: r.run_id != null ? String(r.run_id) : null,
    profileId: r.profile_id != null ? String(r.profile_id) : null,
    profileName: r.profile_name != null ? String(r.profile_name) : null,
    lesson: String(r.lesson),
    status: String(r.status),
    createdAt: Number(r.created_at),
    reviewedAt: r.reviewed_at != null ? Number(r.reviewed_at) : null,
  }
}

/** Re-read a single lesson by id and enrich it with its proposing profile's name (looked up only
 *  when profile_id is set). Used by approve/reject to return the same enriched shape as the list. */
function readEnriched(id: string): Record<string, unknown> | null {
  const row = agentMemoryDb.getLesson.get(id) as Record<string, unknown> | undefined
  if (!row) return null
  let profileName: string | null = null
  if (row.profile_id != null) {
    const prof = agentProfilesDb.getProfileRow.get(String(row.profile_id)) as
      | { name?: unknown }
      | undefined
    profileName = prof?.name != null ? String(prof.name) : null
  }
  return rowToMemoryLesson({ ...row, profile_name: profileName })
}

export async function memoryRoutes(app: FastifyInstance) {
  // GET /api/memory/lessons?status=&profileId= — the review queue. One batched, joined query
  // (NO per-item fan-out). `status` defaults to 'pending'; an unknown status is a 400.
  app.get<{ Querystring: { status?: string; profileId?: string } }>(
    '/api/memory/lessons',
    async (req, reply) => {
      const status = req.query.status ?? 'pending'
      if (!LESSON_STATUSES.has(status)) {
        return reply.status(400).send({ error: 'invalid status' })
      }
      const profileId = req.query.profileId
      const rows = (
        profileId != null && profileId !== ''
          ? agentMemoryDb.listLessonsByStatusProfileJoined.all(status, profileId, 200)
          : agentMemoryDb.listLessonsByStatusJoined.all(status, 200)
      ) as Record<string, unknown>[]
      return reply.send(rows.map(rowToMemoryLesson))
    },
  )

  // POST /api/memory/lessons/:id/approve — pending→accepted. Validate-before-mutate: 404 if the
  // lesson is gone, 409 if it isn't pending (already reviewed), else flip + stamp reviewed_at.
  app.post<{ Params: { id: string } }>('/api/memory/lessons/:id/approve', async (req, reply) => {
    const row = agentMemoryDb.getLesson.get(req.params.id) as { status?: string } | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    if (row.status !== 'pending') return reply.status(409).send({ error: 'lesson is not pending' })
    agentMemoryDb.updateLessonStatus.run({ id: req.params.id, status: 'accepted', reviewedAt: Date.now() })
    const enriched = readEnriched(req.params.id)
    if (!enriched) return reply.status(500).send({ error: 'lesson vanished after update' })
    return reply.send(enriched)
  })

  // POST /api/memory/lessons/:id/reject — identical guards, pending→rejected.
  app.post<{ Params: { id: string } }>('/api/memory/lessons/:id/reject', async (req, reply) => {
    const row = agentMemoryDb.getLesson.get(req.params.id) as { status?: string } | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    if (row.status !== 'pending') return reply.status(409).send({ error: 'lesson is not pending' })
    agentMemoryDb.updateLessonStatus.run({ id: req.params.id, status: 'rejected', reviewedAt: Date.now() })
    const enriched = readEnriched(req.params.id)
    if (!enriched) return reply.status(500).send({ error: 'lesson vanished after update' })
    return reply.send(enriched)
  })
}
