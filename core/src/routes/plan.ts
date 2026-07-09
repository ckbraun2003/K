import type { FastifyInstance } from 'fastify'
import { UpdateRunPlanBodySchema, PlanDocSchema, type RunPlan } from '@k/shared'
import { runsDb, runPlansDb } from '../db.js'
import { approvePlanRun, discardPlanRun } from '../supervisor.js'
import { sendError, sendZodError } from './http-errors.js'

/** run_plans row → wire RunPlan. Defensive plan parse: a corrupt stored doc
 *  reads back null (raw is still served) — never a 500. */
export function rowToRunPlan(r: Record<string, unknown>): RunPlan {
  let plan: RunPlan['plan'] = null
  if (r.plan != null) {
    try {
      const parsed = PlanDocSchema.safeParse(JSON.parse(String(r.plan)))
      plan = parsed.success ? parsed.data : null
    } catch { plan = null }
  }
  return {
    runId: String(r.run_id),
    plan,
    raw: String(r.raw),
    edited: r.edited === 1,
    profileId: r.profile_id != null ? String(r.profile_id) : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    approvedAt: r.approved_at != null ? Number(r.approved_at) : null,
  }
}

/** E-02 Plan Gate routes (plan read / edit / approve / discard). */
export async function planRoutes(app: FastifyInstance) {
  // GET /api/runs/:id/plan — 404 unknown run or no plan row.
  app.get<{ Params: { id: string } }>('/api/runs/:id/plan', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    const row = runPlansDb.getRunPlan.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'run has no plan')
    return reply.send(rowToRunPlan(row))
  })

  // PATCH /api/runs/:id/plan — structured last-wins edit; only while parked.
  // Zod 400 BEFORE existence 404 (F-022 house order).
  app.patch<{ Params: { id: string } }>('/api/runs/:id/plan', async (req, reply) => {
    const parsed = UpdateRunPlanBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const run = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!run) return sendError(reply, 404, 'not found')
    const row = runPlansDb.getRunPlan.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'run has no plan')
    if (run.status !== 'awaiting_plan') return sendError(reply, 409, 'run is not awaiting plan approval')
    runPlansDb.updateRunPlanDoc.run({
      runId: req.params.id,
      plan: JSON.stringify(parsed.data.plan),
      updatedAt: Date.now(),
    })
    return reply.send(rowToRunPlan(runPlansDb.getRunPlan.get(req.params.id) as Record<string, unknown>))
  })

  // POST /api/runs/:id/approve-plan — CAS approve (E-02 double-send: loser 409s).
  app.post<{ Params: { id: string } }>('/api/runs/:id/approve-plan', async (req, reply) => {
    const res = await approvePlanRun(req.params.id)
    if (!res.ok) return sendError(reply, res.code, res.error)
    return reply.send({ run: res.run })
  })

  // POST /api/runs/:id/discard-plan — kill the park (worktree + config dir removed).
  app.post<{ Params: { id: string } }>('/api/runs/:id/discard-plan', async (req, reply) => {
    const res = await discardPlanRun(req.params.id)
    if (!res.ok) return sendError(reply, res.code, res.error)
    return reply.send({ run: res.run })
  })
}
