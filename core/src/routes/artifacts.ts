import type { FastifyInstance } from 'fastify'
import { getArtifact, listArtifacts, saveArtifact } from '../artifacts.js'

export async function artifactsRoutes(app: FastifyInstance) {
  // GET /api/artifacts — list all (no md/html, metadata only)
  app.get('/api/artifacts', async (_req, reply) => {
    return reply.send(listArtifacts())
  })

  // GET /api/artifacts/:slug — single artifact with md + rendered html
  app.get<{ Params: { slug: string } }>('/api/artifacts/:slug', async (req, reply) => {
    const artifact = await getArtifact(req.params.slug)
    if (!artifact) return reply.status(404).send({ error: 'not found' })
    return reply.send(artifact)
  })

  // PUT /api/artifacts/:slug — create or update an artifact
  app.put<{
    Params: { slug: string }
    Body: { md: string; title?: string; phase?: string; status?: string; tags?: string[] }
  }>('/api/artifacts/:slug', async (req, reply) => {
    const { md, ...meta } = req.body
    if (!md) return reply.status(400).send({ error: 'md is required' })
    const artifact = await saveArtifact(req.params.slug, md, { title: meta.title ?? req.params.slug, ...meta })
    return reply.status(200).send({ slug: artifact.slug, updatedAt: artifact.updatedAt })
  })
}
