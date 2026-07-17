/**
 * Runtime Claude default-model route (P5.5).
 *
 * The global Claude default model used to be an env-frozen `const` in router.ts.
 * It is now runtime-managed via config-store (app_config key `claude.model`) and
 * exposed here so Settings can read + change it with no restart. PUT validates
 * against the shared KNOWN_MODELS registry (the same gate the per-run picker uses)
 * so an unknown id can never become the default.
 *
 * Ollama model management lives in routes/ollama.ts; this file owns the Claude
 * default only.
 */
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { KNOWN_MODELS, isKnownModel } from '@k/shared'
import { claudeDefaultModel, setClaudeDefaultModel } from '../config-store.js'
import { resolveAvailableModels } from '../models.js'

const ModelBodySchema = z.object({ model: z.string().min(1).max(200) })

export async function modelsRoutes(app: FastifyInstance) {
  // GET /api/claude/model — the live default model + the selectable known models.
  app.get('/api/claude/model', async (_req, reply) => {
    return reply.send({
      model: claudeDefaultModel(),
      options: KNOWN_MODELS.map(m => ({ id: m.id, label: m.label })),
    })
  })

  // PUT /api/claude/model — set the runtime default (applies to the next run, no
  // restart). Validated against the known registry: 400 on an unknown id.
  app.put('/api/claude/model', async (req, reply) => {
    const parsed = ModelBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    if (!isKnownModel(parsed.data.model)) return reply.status(400).send({ error: 'unknown model' })
    setClaudeDefaultModel(parsed.data.model)
    return reply.send({ model: parsed.data.model })
  })

  // GET /api/models/available — the unified Claude + local (Ollama) model set,
  // for any per-agent model picker (orchestrator/sub-agent defaults). Never
  // 500s when Ollama is unreachable; degrades to Claude-only + localDegraded.
  app.get('/api/models/available', async (_req, reply) => {
    return reply.send(await resolveAvailableModels())
  })
}
