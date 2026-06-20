/**
 * Phase H Wave 1 — knowledge-graph build engine.
 *
 * Unit-tests the build lifecycle (buildGraph / getGraphMeta / isGraphStale) with
 * the analyze runner swapped out via __setAnalyzeRunner, plus the HTTP surface
 * (POST /graph/build, GET /graph) via buildApp + app.inject. The real GitNexus
 * CLI is NEVER invoked. DB is isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Project, WsMessage } from '@k/shared'
import { db, projectsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { buildGraph, getGraphMeta, isGraphStale, __setAnalyzeRunner } from '../src/graph.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'k-graph-'))
}

/** Write a .gitnexus/meta.json into a repo dir, mimicking a gitnexus analyze run. */
function writeGitnexusMeta(dir: string, lastCommit: string, nodes: number, edges: number): void {
  const gx = path.join(dir, '.gitnexus')
  fs.mkdirSync(gx, { recursive: true })
  fs.writeFileSync(path.join(gx, 'meta.json'), JSON.stringify({ lastCommit, stats: { nodes, edges } }))
}

function insertProject(localPath: string): Project {
  const id = uuid()
  projectsDb.insertProject.run({
    id,
    name: `graph-test-${id.slice(0, 8)}`,
    localPath,
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  return { id, name: `graph-test-${id.slice(0, 8)}`, localPath, workspaceManaged: false, bibleDir: 'docs/bible', createdAt: Date.now() }
}

afterAll(() => {
  __setAnalyzeRunner(null)
})

beforeEach(() => {
  __setAnalyzeRunner(null)
})

// ── buildGraph lifecycle ──────────────────────────────────────────────────────

describe('buildGraph', () => {
  it('idle meta before any build', () => {
    const p = insertProject(tmpRepo())
    expect(getGraphMeta(p.id)).toMatchObject({ status: 'idle', builtAt: null, nodeCount: 0, edgeCount: 0 })
  })

  it('runs analyze, reads stats from meta.json, marks ready, broadcasts', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    const seen: WsMessage[] = []
    const off = eventBus.onBroadcast(m => seen.push(m))

    __setAnalyzeRunner(async (cwd) => writeGitnexusMeta(cwd, 'commit-abc', 12, 30))
    const meta = await buildGraph(p)
    off()

    expect(meta).toMatchObject({ status: 'ready', lastCommit: 'commit-abc', nodeCount: 12, edgeCount: 30, error: null })
    expect(typeof meta.builtAt).toBe('number')
    expect(getGraphMeta(p.id).status).toBe('ready')
    // building + ready broadcasts both fired
    const graphMsgs = seen.filter(m => m.type === 'graph_update')
    expect(graphMsgs.map(m => (m as { meta: { status: string } }).meta.status)).toEqual(['building', 'ready'])
  })

  it('marks error (without throwing) when analyze fails', async () => {
    const p = insertProject(tmpRepo())
    __setAnalyzeRunner(async () => { throw new Error('gitnexus not found') })
    const meta = await buildGraph(p)
    expect(meta.status).toBe('error')
    expect(meta.error).toContain('gitnexus not found')
  })

  it('marks error when analyze produces no graph artifacts', async () => {
    const p = insertProject(tmpRepo()) // empty dir, runner writes nothing
    __setAnalyzeRunner(async () => { /* no-op: no .gitnexus written */ })
    const meta = await buildGraph(p)
    expect(meta.status).toBe('error')
  })

  it('concurrent build is a no-op guard', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    let resolveAnalyze: () => void = () => {}
    __setAnalyzeRunner(() => new Promise<void>(res => { resolveAnalyze = () => { writeGitnexusMeta(dir, 'c1', 1, 1); res() } }))
    const first = buildGraph(p)
    // second call while first is in flight returns immediately with building meta
    const second = await buildGraph(p)
    expect(second.status).toBe('building')
    resolveAnalyze()
    await first
    expect(getGraphMeta(p.id).status).toBe('ready')
  })
})

// ── isGraphStale ──────────────────────────────────────────────────────────────

describe('isGraphStale', () => {
  it('stale when never built', async () => {
    const p = insertProject(tmpRepo())
    expect(await isGraphStale(p)).toBe(true)
  })

  it('not stale right after a build in a non-git dir (head unknown)', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    __setAnalyzeRunner(async (cwd) => writeGitnexusMeta(cwd, 'c1', 2, 2))
    await buildGraph(p)
    expect(await isGraphStale(p)).toBe(false)
  })
})

// ── HTTP surface ──────────────────────────────────────────────────────────────

describe('graph routes', () => {
  let app: FastifyInstance
  let project: Project

  beforeAll(async () => {
    process.env.K_SKIP_BOOTSTRAP = '1'
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()
    project = insertProject(tmpRepo())
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /graph 404 for unknown project', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${uuid()}/graph`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('GET /graph returns empty+stale+meta when never built', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/graph`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ nodes: [], links: [], stale: true, status: 'idle' })
  })

  it('POST /graph/build 404 for unknown project', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${uuid()}/graph/build`, headers: AUTH })
    expect(res.statusCode).toBe(404)
  })

  it('POST /graph/build 202 then graph becomes ready (fake analyze)', async () => {
    __setAnalyzeRunner(async (cwd) => {
      writeGitnexusMeta(cwd, 'route-commit', 4, 6)
      // also write graph.json so GET returns nodes
      fs.writeFileSync(
        path.join(cwd, '.gitnexus', 'graph.json'),
        JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] }),
      )
    })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/graph/build`, headers: AUTH })
    expect(res.statusCode).toBe(202)
    expect(['building', 'ready']).toContain(res.json().status)

    // build is fire-and-forget; allow microtasks to settle
    await new Promise(r => setTimeout(r, 20))
    const get = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/graph`, headers: AUTH })
    const body = get.json()
    expect(body.status).toBe('ready')
    expect(body.nodes.length).toBe(2)
    expect(body.nodeCount).toBe(4)
  })
})
