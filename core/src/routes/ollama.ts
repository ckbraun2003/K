/**
 * Ollama model-management routes.
 *
 * Exposes installed models, the curated catalog, pull with live WS progress,
 * active-model selection, and model removal. Generation itself stays on the
 * existing `ollama run` CLI path — this surface is admin/config only.
 *
 * Unreachable-Ollama convention: GET /api/ollama/models returns 200 with
 * { installed: [], active, degraded: true } (mirrors the router's graceful
 * posture). Routes that MUST reach Ollama (set-active, remove) return 502.
 *
 * Pull runs async (202 immediately) and broadcasts `ollama_pull` WS messages
 * via eventBus.broadcast() for each progress update. An in-memory AbortController
 * map allows cancellation via POST /api/ollama/pull/cancel.
 */

import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  listInstalled,
  pull,
  remove,
  OllamaNetworkError,
} from '../ollama-client.js'
import { CATALOG, freeDiskBytes, fitsOnDisk } from '../ollama-catalog.js'
import { activeOllamaModel, setActiveOllamaModel } from '../config-store.js'
import { eventBus } from '../events.js'

// Model name: non-empty, bounded, safe charset (handles `name:tag` and
// namespaced `library/name:tag` forms). Validated at every boundary. The slash
// in namespaced tags is why remove takes the name in the BODY (a `/:name` path
// param can't carry it), keeping all four mutating routes body-validated alike.
const MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/
const ModelNameSchema = z.string().min(1).max(200).regex(MODEL_NAME_RE, 'invalid model name')

const PullBodySchema = z.object({ name: ModelNameSchema })
const CancelBodySchema = z.object({ name: ModelNameSchema })
const RemoveBodySchema = z.object({ name: ModelNameSchema })
const ActiveBodySchema = z.object({ model: ModelNameSchema })

// In-memory registry of active pulls keyed by model name.
const activePulls = new Map<string, AbortController>()

/** Reset the registry between tests (exported for test isolation). */
export function __resetActivePulls(): void {
  for (const ctrl of activePulls.values()) {
    try { ctrl.abort() } catch { /* ignore */ }
  }
  activePulls.clear()
}

export async function ollamaRoutes(app: FastifyInstance) {
  // ── GET /api/ollama/models ──────────────────────────────────────────────────
  // Lists installed Ollama models + the active model name.
  // Graceful: if Ollama is unreachable, return 200 { installed:[], active, degraded:true }.
  app.get('/api/ollama/models', async (_req, reply) => {
    const active = activeOllamaModel()
    try {
      const installed = await listInstalled()
      return reply.send({ installed, active })
    } catch {
      return reply.send({ installed: [], active, degraded: true })
    }
  })

  // ── GET /api/ollama/catalog ─────────────────────────────────────────────────
  // Returns the curated catalog annotated with installed status + disk fit.
  app.get('/api/ollama/catalog', async (_req, reply) => {
    let installed: { name: string }[] = []
    try {
      installed = await listInstalled()
    } catch {
      // Proceed with empty installed list (catalog still useful for browsing).
    }
    const installedNames = new Set(installed.map(m => m.name))
    const free = await freeDiskBytes()
    const items = await Promise.all(
      CATALOG.map(async entry => ({
        ...entry,
        installed: installedNames.has(entry.name),
        fitsOnDisk: await fitsOnDisk(entry.sizeBytes),
      })),
    )
    return reply.send({ items, freeDiskBytes: free })
  })

  // ── POST /api/ollama/pull ───────────────────────────────────────────────────
  // Validates name; returns 202 immediately; runs pull async, broadcasting
  // ollama_pull WS messages for each progress update and a final done message.
  app.post('/api/ollama/pull', async (req, reply) => {
    const parsed = PullBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { name } = parsed.data

    // Abort any in-progress pull for the same model before starting a new one.
    const existing = activePulls.get(name)
    if (existing) {
      try { existing.abort() } catch { /* ignore */ }
    }

    const ctrl = new AbortController()
    activePulls.set(name, ctrl)

    void (async () => {
      try {
        await pull(
          name,
          (progress) => {
            const total = progress.total
            const completed = progress.completed
            const percent =
              total != null && total > 0 && completed != null
                ? Math.round((completed / total) * 100)
                : undefined
            eventBus.broadcast({
              type: 'ollama_pull',
              name,
              status: progress.status,
              total,
              completed,
              percent,
              done: false,
            })
          },
          ctrl.signal,
        )
        eventBus.broadcast({ type: 'ollama_pull', name, status: 'done', done: true })
      } catch (e) {
        // We own this controller and abort it ourselves on cancel, so the
        // authoritative "was this cancelled?" signal is the controller's own
        // aborted flag — not the error text (which varies by error source).
        const cancelled = ctrl.signal.aborted
        eventBus.broadcast({
          type: 'ollama_pull',
          name,
          status: cancelled ? 'cancelled' : 'error',
          done: true,
          error: e instanceof Error ? e.message : String(e),
        })
      } finally {
        // Only remove our own controller (a newer pull may have replaced it).
        if (activePulls.get(name) === ctrl) activePulls.delete(name)
      }
    })()

    return reply.status(202).send({ name, queued: true })
  })

  // ── POST /api/ollama/pull/cancel ────────────────────────────────────────────
  app.post('/api/ollama/pull/cancel', async (req, reply) => {
    const parsed = CancelBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { name } = parsed.data
    const ctrl = activePulls.get(name)
    if (ctrl) {
      try { ctrl.abort() } catch { /* ignore */ }
      activePulls.delete(name)
    }
    return reply.send({ cancelled: name })
  })

  // ── POST /api/ollama/active ─────────────────────────────────────────────────
  // Sets the active model — validates it is actually installed first (400 if not).
  app.post('/api/ollama/active', async (req, reply) => {
    const parsed = ActiveBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { model } = parsed.data

    let installed: { name: string }[]
    try {
      installed = await listInstalled()
    } catch (e) {
      if (e instanceof OllamaNetworkError) {
        return reply.status(502).send({ error: 'Ollama unreachable' })
      }
      app.log.error(e)
      return reply.status(502).send({ error: 'Ollama unreachable' })
    }

    if (!installed.some(m => m.name === model)) {
      return reply.status(400).send({ error: 'model not installed' })
    }

    setActiveOllamaModel(model)
    return reply.send({ active: model })
  })

  // ── DELETE /api/ollama/models ──────────────────────────────────────────────
  // Removes a model named in the request body. Body (not a `/:name` path param)
  // so namespaced tags containing `/` are routable, consistent with the other
  // mutating routes.
  app.delete('/api/ollama/models', async (req, reply) => {
    const parsed = RemoveBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { name } = parsed.data
    try {
      await remove(name)
    } catch (e) {
      if (e instanceof OllamaNetworkError) {
        return reply.status(502).send({ error: e.message })
      }
      app.log.error(e)
      return reply.status(500).send({ error: 'remove failed' })
    }
    return reply.send({ removed: name })
  })
}
