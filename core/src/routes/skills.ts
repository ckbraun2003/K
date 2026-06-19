import type { FastifyInstance } from 'fastify'
import { validate as cronValidate } from 'node-cron'
import { CreateSkillSchema, UpdateSkillSchema } from '@k/shared'
import { skillsDb } from '../db.js'
import { listSkills, listSkillEvals, registerSkill, rowToSkill, runSkillTest, triggerSkill } from '../skills.js'

export async function skillsRoutes(app: FastifyInstance) {
  // GET /api/skills — list all skills
  app.get('/api/skills', async (_req, reply) => {
    return reply.send(listSkills())
  })

  // POST /api/skills — create a skill
  app.post('/api/skills', async (req, reply) => {
    const parsed = CreateSkillSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    // Trigger-type / field consistency: a schedule trigger needs a valid cron
    // expression; an event trigger needs an event name; manual needs neither.
    if (parsed.data.triggerType === 'schedule') {
      const schedule = parsed.data.schedule
      if (!schedule || !cronValidate(schedule)) {
        return reply.status(400).send({ error: 'schedule trigger requires a valid cron expression' })
      }
    }
    if (parsed.data.triggerType === 'event' && !parsed.data.eventTrigger) {
      return reply.status(400).send({ error: 'event trigger requires an eventTrigger name' })
    }
    const existing = skillsDb.getSkillByName.get(parsed.data.name)
    if (existing) {
      return reply.status(409).send({ error: `a skill named '${parsed.data.name}' already exists` })
    }
    const skill = registerSkill(parsed.data)
    return reply.status(201).send(skill)
  })

  // PATCH /api/skills/:id — update enabled flag and/or schedule/eventTrigger
  app.patch<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })

    const parsed = UpdateSkillSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const body = parsed.data

    // A non-null schedule must be a valid cron expression — same boundary check
    // POST enforces, so a bad cron can never be stored (and silently never fire).
    if (body.schedule != null && !cronValidate(body.schedule)) {
      return reply.status(400).send({ error: 'schedule must be a valid cron expression' })
    }

    if (body.enabled !== undefined) {
      skillsDb.updateSkillEnabled.run(body.enabled ? 1 : 0, req.params.id)
    }
    if (body.schedule !== undefined || body.eventTrigger !== undefined) {
      const current = rowToSkill(row as Record<string, unknown>)
      skillsDb.updateSkillSchedule.run(
        body.schedule !== undefined ? body.schedule : current.schedule ?? null,
        body.eventTrigger !== undefined ? body.eventTrigger : current.eventTrigger ?? null,
        req.params.id,
      )
    }

    const updated = skillsDb.getSkill.get(req.params.id) as Record<string, unknown>
    return reply.send(rowToSkill(updated))
  })

  // DELETE /api/skills/:id — remove a skill (204 no content)
  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    skillsDb.deleteSkill.run(req.params.id)
    return reply.status(204).send()
  })

  // POST /api/skills/:id/trigger — manual trigger (202 + { skillRunId, runId })
  app.post<{ Params: { id: string } }>('/api/skills/:id/trigger', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    try {
      const result = await triggerSkill(req.params.id, 'manual')
      return reply.status(202).send(result)
    } catch (e) {
      req.log.error(e)
      return reply.status(500).send({ error: 'trigger failed' })
    }
  })

  // POST /api/skills/:id/test — dispatch an eval-harness test (202 + { evalId, runId })
  app.post<{ Params: { id: string } }>('/api/skills/:id/test', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    try {
      const result = await runSkillTest(req.params.id)
      return reply.status(202).send(result)
    } catch (e) {
      req.log.error(e)
      return reply.status(500).send({ error: 'test failed' })
    }
  })

  // GET /api/skills/:id/evals — list recent skill_evals
  app.get<{ Params: { id: string } }>('/api/skills/:id/evals', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(listSkillEvals(req.params.id))
  })

  // GET /api/skills/:id/runs — list recent skill_runs
  app.get<{ Params: { id: string } }>('/api/skills/:id/runs', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return reply.status(404).send({ error: 'not found' })
    const runs = skillsDb.listSkillRuns.all(req.params.id) as Record<string, unknown>[]
    return reply.send(
      runs.map(r => ({
        id: String(r.id),
        skillId: String(r.skillId),
        runId: r.runId != null ? String(r.runId) : null,
        triggeredBy: String(r.triggeredBy),
        startedAt: Number(r.startedAt),
        completedAt: r.completedAt != null ? Number(r.completedAt) : null,
        status: String(r.status),
      })),
    )
  })
}
