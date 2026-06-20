import type { FastifyInstance } from 'fastify'
import { getArtifact, listArtifacts, saveArtifact } from '../artifacts.js'
import { compileBible } from '../bible.js'
import { compileProjectUiDemo, seedUiDemo } from '../ui-artifact.js'

// URL-safe slug: leading alphanumeric, then up to 79 of [alnum _ -]. No dots,
// slashes, or %-escapes survive — blocks ../ and ..%2f path-traversal at the boundary.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

export async function artifactsRoutes(app: FastifyInstance) {
  // POST /api/bible/compile — recompile the project bible from its sections
  app.post('/api/bible/compile', async (_req, reply) => {
    const result = await compileBible()
    if (!result) return reply.status(404).send({ error: 'no bible manifest found' })
    return reply.send(result)
  })

  // POST /api/ui-artifact/compile — (re)compile a UI demo artifact. With no body
  // this rebuilds the harness's global `ui-demo`; with { projectId } it compiles
  // a project-scoped demo under `project-<id>-ui-demo`.
  app.post<{ Body?: { projectId?: string } }>(
    '/api/ui-artifact/compile',
    {
      // Lock the body shape: only an optional `projectId` is accepted. This is a
      // structural guardrail — compileUiArtifact writes its `html` to disk
      // VERBATIM (unsanitized), so this schema's `additionalProperties: false`
      // ensures a future caller can't silently smuggle an `html`/`source` field
      // through this route into that verbatim-write path.
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { projectId: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const projectId = req.body?.projectId
      if (projectId !== undefined) {
        // Validate at the boundary: the projectId becomes part of the on-disk slug.
        if (typeof projectId !== 'string' || !SLUG_RE.test(projectId)) {
          return reply.status(400).send({ error: 'invalid projectId' })
        }
        const result = await compileProjectUiDemo(projectId)
        return reply.send(result)
      }
      const result = await seedUiDemo()
      return reply.send(result)
    },
  )

  // GET /api/artifacts — list all (no md/html, metadata only)
  app.get('/api/artifacts', async (_req, reply) => {
    return reply.send(listArtifacts())
  })

  // GET /api/artifacts/:slug — single artifact with md + rendered html
  app.get<{ Params: { slug: string } }>('/api/artifacts/:slug', async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug)) return reply.status(400).send({ error: 'invalid slug' })
    const artifact = await getArtifact(req.params.slug)
    if (!artifact) return reply.status(404).send({ error: 'not found' })
    return reply.send(artifact)
  })

  // PUT /api/artifacts/:slug — create or update an artifact
  app.put<{
    Params: { slug: string }
    Body: { md: string; title?: string; phase?: string; status?: string; tags?: string[] }
  }>('/api/artifacts/:slug', async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug)) return reply.status(400).send({ error: 'invalid slug' })
    const { md, ...meta } = req.body
    if (!md) return reply.status(400).send({ error: 'md is required' })
    const artifact = await saveArtifact(req.params.slug, md, { title: meta.title ?? req.params.slug, ...meta })
    return reply.status(200).send({ slug: artifact.slug, updatedAt: artifact.updatedAt })
  })
}
