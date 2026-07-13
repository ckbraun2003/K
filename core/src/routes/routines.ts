// core/src/routes/routines.ts — E-16 routines first-class: schedule-triggered
// skills projected to RoutineView (derived next-run + measured cost), plus the
// NL→cron boundary (rules-only translator; 400 on invalid/unmappable).
import type { FastifyInstance } from 'fastify'
import { NlToCronBodySchema, type RoutineView } from '@k/shared'
import { listSkills } from '../skills.js'        // skills.ts:57 — mapped Skill[] (camelCase)
import { routinesDb } from '../db.js'            // scheduleSkillRunCost (JOIN skill_runs→runs)
import { nextRunAt, nlToCron } from '../cron-util.js'
import { translateNlToCron } from '../nl-cron-translate.js'
import { sendError, sendZodError } from './http-errors.js'

export async function routinesRoutes(app: FastifyInstance) {
  app.get('/api/routines', async (_req, reply) => {
    const routines: RoutineView[] = listSkills()
      .filter(s => s.triggerType === 'schedule' && typeof s.schedule === 'string' && s.schedule)
      .map(s => {
        // Measured cost: skill_runs has NO cost column — JOIN to runs (scheduleSkillRunCost).
        const runRows = routinesDb.scheduleSkillRunCost.all(s.id) as Array<{ started_at: number; cost_usd: number | null }>
        const totalCostUsd = runRows.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
        const lastRunAt = runRows.length ? Math.max(...runRows.map(r => r.started_at)) : null
        return {
          id: s.id, name: s.name, enabled: s.enabled === true,
          schedule: String(s.schedule), nextRunAt: nextRunAt(String(s.schedule)),
          lastRunAt, runs: runRows.length, totalCostUsd,
        }
      })
    return reply.send(routines)
  })

  app.post('/api/routines/parse-cron', async (req, reply) => {
    const parsed = NlToCronBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const result = await nlToCron(parsed.data.text, translateNlToCron)
    if ('error' in result) return sendError(reply, 400, result.error)
    return reply.send({ cron: result.cron })
  })
}
