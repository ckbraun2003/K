import type { FastifyInstance } from 'fastify'
import { getArtifact, listArtifacts, saveArtifact } from '../artifacts.js'
import { compileBible, isBibleSlug, listBibleSections, saveBibleSection, BibleEditError } from '../bible.js'
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

  // GET /api/artifacts/:slug/sections — a bible's editable sections (slug + frontmatter
  // fields + body). 400 for any non-bible artifact: it has no section sources, so it's
  // edited whole via PUT /api/artifacts/:slug.
  app.get<{ Params: { slug: string } }>('/api/artifacts/:slug/sections', async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug)) return reply.status(400).send({ error: 'invalid slug' })
    const sections = listBibleSections(req.params.slug)
    if (sections === null) {
      return reply.status(400).send({ error: 'not a bible — this artifact has no editable sections' })
    }
    return reply.send({ sections })
  })

  // PUT /api/artifacts/:slug/sections/:sectionSlug — write ONE section body back to its
  // canonical source (frontmatter preserved) and recompile. Durable across recompiles;
  // a project bible stays entirely in the project dir (never K's ARTIFACTS_DIR).
  app.put<{
    Params: { slug: string; sectionSlug: string }
    Body: { body?: string }
  }>('/api/artifacts/:slug/sections/:sectionSlug', async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug) || !SLUG_RE.test(req.params.sectionSlug)) {
      return reply.status(400).send({ error: 'invalid slug' })
    }
    const body = req.body?.body
    if (typeof body !== 'string') return reply.status(400).send({ error: 'body is required' })
    try {
      const result = await saveBibleSection(req.params.slug, req.params.sectionSlug, body)
      if (!result) return reply.status(404).send({ error: 'no bible manifest found' })
      return reply.send({ slug: req.params.slug, section: req.params.sectionSlug, compiledAt: result.compiledAt })
    } catch (e) {
      // A structural/client problem (unknown section, no manifest, not a bible) is a
      // clean 400 — never a silent loss; anything else (fs/db) is a 500.
      if (e instanceof BibleEditError) return reply.status(400).send({ error: e.message })
      req.log.error(e)
      return reply.status(500).send({ error: 'bible section save failed' })
    }
  })

  // PUT /api/artifacts/:slug — create or update an artifact
  app.put<{
    Params: { slug: string }
    Body: { md: string; title?: string; phase?: string; status?: string; tags?: string[] }
  }>('/api/artifacts/:slug', async (req, reply) => {
    if (!SLUG_RE.test(req.params.slug)) return reply.status(400).send({ error: 'invalid slug' })
    // A bible's source of truth is its section files, not this combined md. Writing it
    // here would be silently lost on the next recompile (F-029) and — for a project
    // bible — leak project-<id>-bible.{md,html} into K's ARTIFACTS_DIR while nulling
    // the row's html_path (F-030). Steer the caller to the section editor above.
    if (isBibleSlug(req.params.slug)) {
      return reply.status(400).send({
        error: 'a bible is edited by section — PUT /api/artifacts/:slug/sections/:sectionSlug. Editing the combined markdown would be lost on the next recompile.',
      })
    }
    const { md, ...meta } = req.body
    if (!md) return reply.status(400).send({ error: 'md is required' })
    const artifact = await saveArtifact(req.params.slug, md, { title: meta.title ?? req.params.slug, ...meta })
    return reply.status(200).send({ slug: artifact.slug, updatedAt: artifact.updatedAt })
  })
}
