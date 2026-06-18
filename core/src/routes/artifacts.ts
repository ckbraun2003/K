import type { FastifyInstance } from 'fastify'
import { getArtifact, listArtifacts, saveArtifact } from '../artifacts.js'
import { compileBible } from '../bible.js'

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
