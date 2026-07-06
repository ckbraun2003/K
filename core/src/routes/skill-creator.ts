/**
 * Skill Creator routes (D-071) — the /api/skill-creator/drafts namespace.
 *
 * Drafts lifecycle: POST (create + authoring run, 202) → GET list/detail →
 * PATCH (manual edit) → POST /refine (revision run, 202) → POST /evaluate
 * (eval harness, 202 {evalId, runId}) → GET /evals → POST /save (201 {skill},
 * K's library only) → DELETE.
 *
 * Conventions (routes/skills.ts + http-errors.ts): zod safeParse → sendZodError;
 * validate the body FIRST (400), THEN existence (404) — F-022; lifecycle-state
 * conflicts (DraftStateError) and save collisions (DraftCollisionError) → 409;
 * dispatch acceptance → 202. Auth rides the app-level bearer hook (index.ts)
 * like every /api route.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  DraftCollisionError,
  DraftStateError,
  createDraft,
  deleteDraft,
  evaluateDraft,
  getDraft,
  listDraftEvals,
  listDrafts,
  refineDraft,
  saveDraft,
  updateDraft,
} from '../skill-creator.js'
import { sendError, sendZodError } from './http-errors.js'

// Request bodies are route-local schemas (shared/ is frozen this program; the
// RESPONSE shape is the shared SkillDraftSchema, produced by the service).
// .strict() so a misspelled field is named instead of silently dropped.
const CreateDraftBodySchema = z.object({
  brief: z.string().min(1).max(20000),
  nameHint: z.string().min(1).max(200).nullish(),
}).strict()

const UpdateDraftBodySchema = z.object({
  skillMd: z.string().min(1).max(200000),
}).strict()

const RefineBodySchema = z.object({
  feedback: z.string().min(1).max(20000),
}).strict()

// The library slug. The route gives the friendly 400 (strict kebab-case + the
// Windows reserved-device-name rejection); the service re-asserts the SAME rules
// (assertSafeSegment + kebab + reserved names + path confinement) so the write
// is guarded even for non-route callers.
// KEEP IN LOCKSTEP with skill-creator.ts::saveDraft's slug gates
// (WINDOWS_RESERVED_NAMES + the kebab regex) — the two layers must not drift.
const SaveBodySchema = z.object({
  name: z.string().min(1).max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case (lowercase letters, digits, single hyphens)')
    .refine(n => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(n), 'is a reserved Windows device name'),
}).strict()

export async function skillCreatorRoutes(app: FastifyInstance) {
  // POST /api/skill-creator/drafts — create a draft + dispatch the authoring run.
  // 202: the draft row is durable and the run is in flight (a dispatch failure
  // degrades the draft to 'failed' — still 202, visible/durable, runSkillTest's
  // contract).
  app.post('/api/skill-creator/drafts', async (req, reply) => {
    const parsed = CreateDraftBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const draft = await createDraft({ brief: parsed.data.brief, nameHint: parsed.data.nameHint ?? null })
    return reply.status(202).send(draft)
  })

  // GET /api/skill-creator/drafts — newest first.
  app.get('/api/skill-creator/drafts', async (_req, reply) => {
    return reply.send(listDrafts())
  })

  // GET /api/skill-creator/drafts/:id
  app.get<{ Params: { id: string } }>('/api/skill-creator/drafts/:id', async (req, reply) => {
    const draft = getDraft(req.params.id)
    if (!draft) return sendError(reply, 404, 'not found')
    return reply.send(draft)
  })

  // PATCH /api/skill-creator/drafts/:id — manual edit (bumps revision; 'ready'
  // when content is present). 409 while an authoring run is live.
  app.patch<{ Params: { id: string } }>('/api/skill-creator/drafts/:id', async (req, reply) => {
    const parsed = UpdateDraftBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const draft = updateDraft(req.params.id, { skillMd: parsed.data.skillMd })
      if (!draft) return sendError(reply, 404, 'not found')
      return reply.send(draft)
    } catch (e) {
      if (e instanceof DraftStateError) return sendError(reply, 409, e.message)
      throw e
    }
  })

  // POST /api/skill-creator/drafts/:id/refine — new authoring run against the
  // current content + feedback (202). 409 with no content or a live run.
  app.post<{ Params: { id: string } }>('/api/skill-creator/drafts/:id/refine', async (req, reply) => {
    const parsed = RefineBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const draft = await refineDraft(req.params.id, parsed.data.feedback)
      if (!draft) return sendError(reply, 404, 'not found')
      return reply.status(202).send(draft)
    } catch (e) {
      if (e instanceof DraftStateError) return sendError(reply, 409, e.message)
      throw e
    }
  })

  // POST /api/skill-creator/drafts/:id/evaluate — eval-harness run against the
  // draft's CURRENT content (202 {evalId, runId} — runSkillTest's contract; a
  // dispatch failure still answers 202 with a finalized failed eval + runId '').
  app.post<{ Params: { id: string } }>('/api/skill-creator/drafts/:id/evaluate', async (req, reply) => {
    try {
      const result = await evaluateDraft(req.params.id)
      if (!result) return sendError(reply, 404, 'not found')
      return reply.status(202).send(result)
    } catch (e) {
      if (e instanceof DraftStateError) return sendError(reply, 409, e.message)
      throw e
    }
  })

  // GET /api/skill-creator/drafts/:id/evals — DraftEval[], newest first.
  app.get<{ Params: { id: string } }>('/api/skill-creator/drafts/:id/evals', async (req, reply) => {
    if (!getDraft(req.params.id)) return sendError(reply, 404, 'not found')
    return reply.send(listDraftEvals(req.params.id))
  })

  // POST /api/skill-creator/drafts/:id/save — write agent-config/skills/<slug>/
  // SKILL.md + register the k-native registry row. 201 {skill}; collisions and
  // not-ready state → 409.
  app.post<{ Params: { id: string } }>('/api/skill-creator/drafts/:id/save', async (req, reply) => {
    const parsed = SaveBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    try {
      const result = saveDraft(req.params.id, parsed.data.name)
      if (!result) return sendError(reply, 404, 'not found')
      return reply.status(201).send(result)
    } catch (e) {
      if (e instanceof DraftCollisionError || e instanceof DraftStateError) {
        return sendError(reply, 409, e.message)
      }
      throw e
    }
  })

  // DELETE /api/skill-creator/drafts/:id → 204
  app.delete<{ Params: { id: string } }>('/api/skill-creator/drafts/:id', async (req, reply) => {
    if (!deleteDraft(req.params.id)) return sendError(reply, 404, 'not found')
    return reply.status(204).send()
  })
}
