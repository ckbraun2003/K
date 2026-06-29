/**
 * Campaign S7 (LOCK / gating) — GET /api/projects/:id/graph normalization + degrade.
 *
 * EXTENDS graph.test.ts (which covers toGraphJson + the build lifecycle + the
 * never-built empty case). The GET /graph route normalizes the on-disk graph.json
 * INLINE (its own code path, separate from toGraphJson): nodes id/label fallback,
 * and links from `data.links ?? data.edges` with `source/from` + `target/to`. This
 * file locks that inline normalization plus its graceful degrade on wholly-malformed
 * artifacts:
 *   - `edges` + `from`/`to` normalize to `links` with `source`/`target`/`type`.
 *   - node id falls back to name; label falls back name→id.
 *   - a graph.json whose top-level `nodes` is NOT an array degrades to empty+stale,
 *     200 (no 500).
 *   - an unparseable graph.json degrades to empty+stale, 200 (no 500).
 *
 * Real GitNexus CLI is never invoked. Isolated K_DATA_DIR via vitest.config.ts.
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

/** Write .gitnexus/graph.json (as raw text so we can inject unparseable bytes). */
function writeGraphRaw(raw: string): void {
  const gx = path.join(repo, '.gitnexus')
  fs.mkdirSync(gx, { recursive: true })
  fs.writeFileSync(path.join(gx, 'graph.json'), raw)
}
function writeGraph(obj: unknown): void {
  writeGraphRaw(JSON.stringify(obj))
}
async function getGraph(): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/graph`, headers: AUTH })
  return { status: res.statusCode, body: res.json() }
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s7-graph-'))
  projectId = uuid()
  projectsDb.insertProject.run({
    id: projectId, name: `s7-graph-${projectId.slice(0, 8)}`, localPath: repo,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
})

afterAll(async () => {
  try { db.prepare('DELETE FROM project_graphs WHERE project_id = ?').run(projectId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectId) } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* ignore */ }
  await app.close()
})

describe('GET /graph — inline normalization', () => {
  it('normalizes `edges` + `from`/`to` into `links` with source/target/type', async () => {
    writeGraph({
      nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      edges: [{ from: 'a', to: 'b', type: 'CALLS' }],
    })
    const { status, body } = await getGraph()
    expect(status).toBe(200)
    expect(body.links).toEqual([{ source: 'a', target: 'b', type: 'CALLS' }])
    expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['a', 'b'])
  })

  it('node id falls back to name; label falls back name→id', async () => {
    writeGraph({
      nodes: [
        { name: 'X' },          // no id → id becomes the name
        { id: 'y' },            // no name/label → label becomes the id
        { id: 'z', name: 'Zed', label: 'Z!' },
      ],
      links: [],
    })
    const { body } = await getGraph()
    const byId = Object.fromEntries(body.nodes.map((n: { id: string; label: string }) => [n.id, n.label]))
    expect(byId['X']).toBe('X')   // id fell back to name, label fell back to name
    expect(byId['y']).toBe('y')   // label fell back to id
    expect(byId['z']).toBe('Z!')  // explicit label wins
  })

  it('a well-formed links/source/target graph round-trips unchanged', async () => {
    writeGraph({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b', type: 'IMPORTS' }] })
    const { body } = await getGraph()
    expect(body.nodes).toHaveLength(2)
    expect(body.links).toEqual([{ source: 'a', target: 'b', type: 'IMPORTS' }])
  })
})

describe('GET /graph — graceful degrade on wholly-malformed artifacts', () => {
  it('a non-array top-level `nodes` degrades to empty + stale (200, not 500)', async () => {
    writeGraph({ nodes: { not: 'an array' }, links: [] })
    const { status, body } = await getGraph()
    expect(status).toBe(200)
    expect(body).toMatchObject({ nodes: [], links: [], stale: true })
  })

  it('an unparseable graph.json degrades to empty + stale (200, not 500)', async () => {
    writeGraphRaw('{ this is not: valid json,,,')
    const { status, body } = await getGraph()
    expect(status).toBe(200)
    expect(body).toMatchObject({ nodes: [], links: [], stale: true })
  })
})
