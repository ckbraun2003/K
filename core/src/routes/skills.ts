import type { FastifyInstance } from 'fastify'
import { validate as cronValidate } from 'node-cron'
import { CreateSkillSchema, UpdateSkillSchema } from '@k/shared'
import { skillsDb, projectsDb } from '../db.js'
import { listSkills, listSkillEvals, registerSkill, rowToSkill, runSkillTest, triggerSkill } from '../skills.js'
import { sendError, sendZodError, sendBudgetCapped } from './http-errors.js'
import { budgetGate } from '../budget-governor.js'

export async function skillsRoutes(app: FastifyInstance) {
  // GET /api/skills — list all skills
  app.get('/api/skills', async (_req, reply) => {
    return reply.send(listSkills())
  })

  // POST /api/skills — create a skill
  app.post('/api/skills', async (req, reply) => {
    const parsed = CreateSkillSchema.safeParse(req.body)
    if (!parsed.success) {
      return sendZodError(reply, parsed.error)
    }
    // Trigger-type / field consistency: a schedule trigger needs a valid cron
    // expression; an event trigger needs an event name; manual needs neither.
    if (parsed.data.triggerType === 'schedule') {
      const schedule = parsed.data.schedule
      if (!schedule || !cronValidate(schedule)) {
        return sendError(reply, 400, 'schedule trigger requires a valid cron expression')
      }
    }
    if (parsed.data.triggerType === 'event' && !parsed.data.eventTrigger) {
      return sendError(reply, 400, 'event trigger requires an eventTrigger name')
    }
    const existing = skillsDb.getSkillByName.get(parsed.data.name)
    if (existing) {
      return sendError(reply, 409, `a skill named '${parsed.data.name}' already exists`)
    }
    // registerSkill honors an explicit `enabled:false` (F-016) — a skill created disabled
    // stays disarmed until enabled, so a schedule/event skill can't fire before it's meant to.
    const skill = registerSkill(parsed.data)
    return reply.status(201).send(skill)
  })

  // PATCH /api/skills/:id — update enabled / schedule / eventTrigger and/or the
  // editable content fields (name, description, source). All fields optional.
  //
  // Ordering convention (F-022): VALIDATE the body first (→ 400), THEN check existence
  // (→ 404) — so a bad body against an unknown id answers 400 (the body is wrong
  // regardless of whether the skill exists). This is the wave-wide convention (see
  // routes/http-errors.ts); it flips this route from its former existence-first order.
  //
  // OPTIMISTIC-CONCURRENCY GAP (F-027): the D1 claim of version/stale-409 concurrency is
  // NOT implemented — the skills table carries only `createdAt` (no `version`/`updatedAt`),
  // so the ONLY 409 here is the name-collision below. A last-writer-wins PATCH silently
  // clobbers a concurrent edit. Closing this properly is additive but cross-layer (a
  // `version` column + SCHEMA_VERSION bump, bump-on-every-update, an `expectedVersion` body
  // field, and a web client that sends it) — deferred rather than faked; documented here for
  // a later wave so the claim and the behavior can be reconciled.
  app.patch<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const parsed = UpdateSkillSchema.safeParse(req.body)
    if (!parsed.success) {
      return sendZodError(reply, parsed.error)
    }
    const body = parsed.data

    // A non-null schedule must be a valid cron expression — same boundary check
    // POST enforces, so a bad cron can never be stored (and silently never fire).
    if (body.schedule != null && !cronValidate(body.schedule)) {
      return sendError(reply, 400, 'schedule must be a valid cron expression')
    }

    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')

    // A rename that collides with another skill's UNIQUE name fails gracefully
    // (409) instead of bubbling the SQLite constraint error as a 500 — mirrors
    // the POST uniqueness check. Skip when the name is unchanged (self-match).
    if (body.name !== undefined) {
      const clash = skillsDb.getSkillByName.get(body.name) as { id?: string } | undefined
      if (clash && clash.id !== req.params.id) {
        return sendError(reply, 409, `a skill named '${body.name}' already exists`)
      }
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
    // Editable content fields. Update only when PRESENT in the parsed body
    // (`!== undefined`) — never `||` — so a PATCH that omits a field preserves
    // its stored value. A cleared description ('') normalizes to NULL so
    // "cleared" and "never set" are indistinguishable at the API (rowToSkill maps
    // NULL → undefined). (`source`/`name` have a min(1) bound so '' is rejected
    // at the schema.)
    if (body.name !== undefined || body.description !== undefined || body.source !== undefined) {
      const current = rowToSkill(row as Record<string, unknown>)
      skillsDb.updateSkillContent.run({
        id: req.params.id,
        name: body.name !== undefined ? body.name : current.name,
        description:
          body.description !== undefined
            ? body.description === ''
              ? null
              : body.description
            : current.description ?? null,
        source: body.source !== undefined ? body.source : current.source,
      })
    }

    const updated = skillsDb.getSkill.get(req.params.id) as Record<string, unknown>
    return reply.send(rowToSkill(updated))
  })

  // DELETE /api/skills/:id — remove a skill (204 no content)
  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')
    skillsDb.deleteSkill.run(req.params.id)
    return reply.status(204).send()
  })

  // POST /api/skills/:id/trigger — manual trigger (202 + { skillRunId, runId }).
  // Optional body `projectId` (F-069): run the skill against a chosen registered project
  // (its checkout becomes the run's cwd). Omitted → the skill runs against K, as before.
  app.post<{ Params: { id: string }; Body: { projectId?: string } }>('/api/skills/:id/trigger', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')
    const projectId = req.body?.projectId
    if (projectId !== undefined) {
      if (typeof projectId !== 'string' || projectId.trim().length === 0) {
        return sendError(reply, 400, 'projectId must be a non-empty string')
      }
      if (!projectsDb.getProject.get(projectId)) {
        return sendError(reply, 404, `project not found: ${projectId}`)
      }
    }
    // P5-FU-1: "run skill now" is a PAID dispatch — same budget park as POST
    // /api/runs (after the cheap existence checks, before the side effect).
    const g = budgetGate({ projectId: projectId ?? null })
    if (!g.allowed) return sendBudgetCapped(reply, g)
    try {
      const result = await triggerSkill(req.params.id, 'manual', projectId ? { projectId } : {})
      return reply.status(202).send(result)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'trigger failed')
    }
  })

  // POST /api/skills/:id/test — dispatch an eval-harness test (202 + { evalId, runId })
  app.post<{ Params: { id: string } }>('/api/skills/:id/test', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')
    try {
      const result = await runSkillTest(req.params.id)
      return reply.status(202).send(result)
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'test failed')
    }
  })

  // GET /api/skills/:id/evals — list recent skill_evals
  app.get<{ Params: { id: string } }>('/api/skills/:id/evals', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')
    return reply.send(listSkillEvals(req.params.id))
  })

  // GET /api/skills/:id/runs — list recent skill_runs
  app.get<{ Params: { id: string } }>('/api/skills/:id/runs', async (req, reply) => {
    const row = skillsDb.getSkill.get(req.params.id)
    if (!row) return sendError(reply, 404, 'not found')
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
