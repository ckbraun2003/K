/**
 * REGRESSION — Finding S7-001 (FIXED + promoted to gating, reboot wave F1.W2).
 *
 * GET /api/projects/:id/graph reads the project's .gitnexus/graph.json and
 * normalizes it INLINE with an UNGUARDED `.map`:
 *
 *   const baseNodes = (data.nodes ?? []).map(n => ({ id: n.id ?? n.name, ... , ...n }))
 *   ...
 *   const links = (data.links ?? data.edges ?? []).map(e => ({ source: e.source ?? e.from, ... }))
 *
 * If the nodes (or links) array contains a single `null` / non-object entry among
 * otherwise-valid entries, evaluating `n.id` (or `e.source`) throws a TypeError.
 * That throw is caught by the route's OUTER try/catch, which returns the fully
 * degraded `{ nodes: [], links: [], stale: true }` response. So ONE bad node zeroes
 * out the ENTIRE graph view — every good node and link is lost — rather than the
 * bad entry being skipped individually (the contract toGraphJson upholds at the
 * build layer, but the route does not).
 *
 *   Surface: core/src/routes/projects.ts — GET /api/projects/:id/graph (≈ lines 278-292).
 *   Reachable: graph.json is produced by the external `npx gitnexus analyze` CLI and
 *   read verbatim from disk; a corrupt/partial/third-party-written artifact with a
 *   null entry is consumed directly by the route (no per-entry filtering).
 *
 *   Expected: malformed entries are skipped; the valid nodes/links still render.
 *   Actual:   a single null entry collapses the whole response to empty + stale.
 *
 * FIXED: the route now filters null/non-object entries per-entry (like toGraphJson
 * does at the build layer) BEFORE mapping, so one bad entry is skipped instead of
 * collapsing the whole view → this test gates.
 *
 * Finding row: testing/findings/S7-verify-skills-github-graph.md  (S7-001)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { projectsDb, db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
let projectId: string
let repo: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s7-001-'))
  const gx = path.join(repo, '.gitnexus')
  fs.mkdirSync(gx, { recursive: true })
  // Two valid nodes + one valid link, each polluted by a single null entry.
  fs.writeFileSync(path.join(gx, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'good1', name: 'Good 1' }, null, { id: 'good2', name: 'Good 2' }],
    links: [{ source: 'good1', target: 'good2', type: 'CALLS' }, null],
  }))

  projectId = uuid()
  projectsDb.insertProject.run({
    id: projectId, name: `s7-001-${projectId.slice(0, 8)}`, localPath: repo,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
})

afterAll(async () => {
  try { db.prepare('DELETE FROM project_graphs WHERE project_id = ?').run(projectId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* ignore */ }
  await app.close()
})

describe('S7-001: one malformed (null) graph entry must not zero out the whole graph', () => {
  it('keeps the valid nodes and links instead of collapsing to empty', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/graph`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { nodes: Array<{ id: string }>; links: Array<{ source: string; target: string }> }

    // EXPECTED (safe): the two valid nodes survive; the null entry is skipped.
    // CURRENT (fault): the null node throws inside the route's .map, the outer
    // catch returns { nodes: [], links: [] } — so this assertion is RED.
    expect(body.nodes.map(n => n.id).sort()).toEqual(['good1', 'good2'])
    // …and the valid link survives too (same root cause for the links array).
    expect(body.links).toContainEqual({ source: 'good1', target: 'good2', type: 'CALLS' })
  })
})
