/**
 * Phase H Wave 1 — knowledge-graph build engine.
 *
 * Unit-tests the build lifecycle (buildGraph / getGraphMeta / isGraphStale) with
 * the analyze runner swapped out via __setAnalyzeRunner, plus the HTTP surface
 * (POST /graph/build, GET /graph) via buildApp + app.inject. The real GitNexus
 * CLI is NEVER invoked. DB is isolated via vitest.config.ts K_DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Project, WsMessage } from '@k/shared'
import { db, projectsDb, runsDb, verificationDb, artifactsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { REPO_ROOT } from '../src/supervisor.js'
import {
  buildGraph,
  getGraphMeta,
  isGraphStale,
  enrichNodes,
  registerGraphAutoReindex,
  markStale,
  parseCypherRows,
  toGraphJson,
  __setAnalyzeRunner,
} from '../src/graph.js'

// Real `gitnexus cypher` output captured against the live K index (Wave 8). These
// pin the parser/transform to the tool's ACTUAL stdout format — the guard the
// execa-mocked waves lacked. Re-capture with:
//   npx gitnexus cypher --repo K "MATCH (n) RETURN n LIMIT 3"
//   npx gitnexus cypher --repo K "MATCH (a)-[r]->(b) RETURN {source: a.id, target: b.id, type: label(r)} AS e LIMIT 3"
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CYPHER_NODES = fs.readFileSync(path.join(FIXTURES, 'cypher-nodes.json'), 'utf8')
const CYPHER_EDGES = fs.readFileSync(path.join(FIXTURES, 'cypher-edges.json'), 'utf8')

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

  it('seam writes a graph.json built from the real-fixture transform (Wave 8)', async () => {
    // Mirrors the real runner contract: analyze + export. Here the fake seam runs
    // the SAME pure transform over the real cypher fixture and writes graph.json,
    // so we prove the artifact lands in the route's shape without shelling out.
    const dir = tmpRepo()
    const p = insertProject(dir)
    __setAnalyzeRunner(async (cwd) => {
      writeGitnexusMeta(cwd, 'commit-xyz', 3, 3)
      const graph = toGraphJson(parseCypherRows(CYPHER_NODES), parseCypherRows(CYPHER_EDGES))
      fs.writeFileSync(path.join(cwd, '.gitnexus', 'graph.json'), JSON.stringify(graph))
    })
    await buildGraph(p)

    const written = JSON.parse(fs.readFileSync(path.join(dir, '.gitnexus', 'graph.json'), 'utf8'))
    expect(written.nodes.length).toBe(3)
    expect(written.links.length).toBe(3)
    const folder = written.nodes.find((n: { id: string }) => n.id === 'Folder:web')
    expect(folder).toBeDefined()
    expect('embedding' in folder).toBe(false)
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

// ── cypher parsing / transform (Wave 8 — pure, pinned to REAL tool output) ──────

describe('parseCypherRows (real fixture)', () => {
  it('drops header + separator rows and JSON-parses each single-column node cell', () => {
    const rows = parseCypherRows(CYPHER_NODES) as Array<Record<string, unknown>>
    expect(rows.length).toBe(3)
    // Shape pinned to the actual tool output: id/name/filePath/_label + null noise.
    expect(rows[0].id).toBe('Folder:web')
    expect(rows[0].name).toBe('web')
    expect(rows[0].filePath).toBe('web')
    expect(rows[0]._label).toBe('Folder')
    expect(rows[0].embedding).toBeNull()
  })

  it('parses single-column edge cells', () => {
    const rows = parseCypherRows(CYPHER_EDGES) as Array<Record<string, unknown>>
    expect(rows.length).toBe(3)
    expect(rows[0].source).toBe('File:web/src/main.tsx')
    expect(rows[0].target).toBe('File:web/src/index.css')
    expect(rows[0].type).toBe('CodeRelation')
  })

  it('returns [] for empty / malformed stdout (no throw)', () => {
    expect(parseCypherRows(JSON.stringify({ markdown: '| n |\n| --- |' }))).toEqual([])
    expect(parseCypherRows(JSON.stringify({ row_count: 0 }))).toEqual([])
  })
})

describe('toGraphJson (real fixture)', () => {
  it('transforms raw rows into the lean route shape and keeps ids so links resolve', () => {
    const nodeRows = parseCypherRows(CYPHER_NODES)
    const edgeRows = parseCypherRows(CYPHER_EDGES)
    const { nodes, links } = toGraphJson(nodeRows, edgeRows)

    expect(nodes.length).toBe(3)
    // Noise dropped; _label mapped to type AND group; filePath → file; id verbatim.
    const folder = nodes.find(n => n.id === 'Folder:web')
    expect(folder).toEqual({
      id: 'Folder:web', name: 'web', label: 'web', type: 'Folder', file: 'web', group: 'Folder',
    })
    expect('embedding' in folder!).toBe(false)
    expect('_id' in folder!).toBe(false)

    expect(links.length).toBe(3)
    const link = links.find(l => l.source === 'File:web/src/main.tsx')
    expect(link).toEqual({
      source: 'File:web/src/main.tsx', target: 'File:web/src/index.css', type: 'CodeRelation',
    })
  })

  it('falls back label→id only when name is unset OR empty-string', () => {
    const { nodes } = toGraphJson(
      [
        { id: 'A', name: 'real', _label: 'File' },
        { id: 'B', name: '', _label: 'File' },     // empty name is not a usable label
        { id: 'C', _label: 'File' },                // missing name
      ],
      [],
    )
    expect(nodes.map(n => n.label)).toEqual(['real', 'B', 'C'])
  })

  it('drops nodes without a string id and edges missing source/target', () => {
    const { nodes, links } = toGraphJson(
      [{ name: 'no-id' }, { id: 'ok' }],
      [{ source: 'a' }, { source: 'a', target: 'b', type: 'X' }],
    )
    expect(nodes.map(n => n.id)).toEqual(['ok'])
    expect(links.length).toBe(1)
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

    // build is fire-and-forget; poll until it settles. A fixed 20ms sleep races
    // under heavy full-suite load (intermittently observed status still 'building'),
    // so poll up to ~2s for the background analyze to flip the row to 'ready'.
    let body: { status: string; nodes: unknown[]; nodeCount: number } | undefined
    for (let i = 0; i < 100; i++) {
      const get = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/graph`, headers: AUTH })
      body = get.json()
      if (body!.status === 'ready') break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(body!.status).toBe('ready')
    expect(body!.nodes.length).toBe(2)
    expect(body!.nodeCount).toBe(4)
  })
})

// ── live node enrichment (Wave 2) ───────────────────────────────────────────────

function insertRun(projectId: string, prompt: string, status = 'done'): string {
  const id = uuid()
  runsDb.insertRun.run({
    id, prompt, cwd: '/tmp', worktree: null, status,
    provider: 'claude', model: 'claude-sonnet-4-6',
    tokensIn: 0, tokensOut: 0, costUsd: 0, projectId, createdAt: Date.now(),
  })
  return id
}

describe('enrichNodes', () => {
  it('attaches lastRun + findings, and inBible ONLY for the harness-root project', () => {
    // The project-bible artifact is the harness's OWN global bible, so inBible is
    // only meaningful when the project IS the harness repo (localPath = REPO_ROOT).
    const p = insertProject(REPO_ROOT)
    const runId = insertRun(p.id, 'Investigate failing tests in src/widget.ts please')

    // a verification report whose finding references the same file
    verificationDb.insertVerificationReport.run({
      id: uuid(), projectId: p.id, score: 50,
      findings: JSON.stringify([{ severity: 'warn', area: 'tests', message: 'flaky test in src/widget.ts' }]),
      fixesApplied: JSON.stringify([]), startedAt: Date.now(), completedAt: Date.now(),
      scoreBreakdown: null, coveragePct: null,
    })
    // the compiled bible references the file too
    artifactsDb.upsertArtifact.run({
      slug: 'project-bible', title: 'Bible', phase: null, status: 'active',
      tags: JSON.stringify([]), linkedRunId: null, updatedAt: Date.now(),
      md: 'The widget lives at src/widget.ts and is core.', htmlPath: null, projectId: null,
    })

    const [node] = enrichNodes(p, [{ id: 'n1', label: 'widget', file: 'src/widget.ts' }])
    const e = (node as { enrichment?: Record<string, unknown> }).enrichment
    expect(e).toBeDefined()
    expect((e!.lastRun as { runId: string }).runId).toBe(runId)
    expect((e!.findings as unknown[]).length).toBe(1)
    expect(e!.inBible).toBe(true)
  })

  it('omits inBible for a NON-harness project even when the global bible matches', () => {
    // Same bible text references the file, but this project is not the harness repo,
    // so the global project-bible must NOT contribute inBible to its nodes.
    const p = insertProject(tmpRepo())
    insertRun(p.id, 'Investigate src/widget.ts please')
    artifactsDb.upsertArtifact.run({
      slug: 'project-bible', title: 'Bible', phase: null, status: 'active',
      tags: JSON.stringify([]), linkedRunId: null, updatedAt: Date.now(),
      md: 'The widget lives at src/widget.ts and is core.', htmlPath: null, projectId: null,
    })

    const [node] = enrichNodes(p, [{ id: 'n1', label: 'widget', file: 'src/widget.ts' }])
    const e = (node as { enrichment?: Record<string, unknown> }).enrichment
    expect(e).toBeDefined()                 // lastRun still attaches
    expect(e!.lastRun).toBeDefined()
    expect(e!.inBible).toBeUndefined()      // but inBible is scoped out
  })

  it('omits enrichment for a node with no derivable facts (no throw)', () => {
    const p = insertProject(tmpRepo())
    const nodes = enrichNodes(p, [{ id: 'orphan', label: 'src/nowhere-xyz.ts', file: 'src/nowhere-xyz.ts' }])
    expect((nodes[0] as { enrichment?: unknown }).enrichment).toBeUndefined()
  })

  it('is graceful when sources are entirely absent', () => {
    const p = insertProject(tmpRepo())
    expect(() => enrichNodes(p, [{ id: 'x', label: 'foo', file: 'foo.ts' }])).not.toThrow()
  })
})

// ── auto-reindex (Wave 2) ───────────────────────────────────────────────────────

describe('registerGraphAutoReindex', () => {
  beforeEach(() => { vi.useFakeTimers(); delete process.env.GRAPH_AUTO_REINDEX })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('a qualifying run-completion triggers exactly ONE debounced rebuild', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    let analyzeCalls = 0
    __setAnalyzeRunner(async (cwd) => { analyzeCalls++; writeGitnexusMeta(cwd, 'c1', 1, 1) })

    const off = registerGraphAutoReindex(() => p, 50)
    try {
      // burst of three completions for the same project collapses to one rebuild
      for (let i = 0; i < 3; i++) eventBus.emitRunUpdate(makeRun(p.id, 'done'))
      expect(analyzeCalls).toBe(0)              // debounced — nothing yet
      await vi.advanceTimersByTimeAsync(60)
      await vi.runAllTimersAsync()
      expect(analyzeCalls).toBe(1)              // exactly one rebuild fired
      // buildGraph's await-chain (analyze → readGraphStats) settles on real
      // microtasks; flush them under fake timers before asserting terminal state.
      vi.useRealTimers()
      await new Promise(r => setTimeout(r, 20))
      expect(getGraphMeta(p.id).status).toBe('ready')
    } finally {
      off()
    }
  })

  it('does not trigger when a build is already in flight (guard)', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    // never-resolving analyze → build stays in flight. Count invocations so we can
    // assert the guard prevents the analyze seam from being entered a SECOND time.
    let analyzeCalls = 0
    __setAnalyzeRunner(() => { analyzeCalls++; return new Promise<void>(() => {}) })
    const first = buildGraph(p)                 // occupy the in-flight guard
    void first
    expect(getGraphMeta(p.id).status).toBe('building')
    expect(analyzeCalls).toBe(1)                // the in-flight build's single analyze

    let secondAnalyze = 0
    const off = registerGraphAutoReindex(() => { secondAnalyze++; return p }, 50)
    try {
      eventBus.emitRunUpdate(makeRun(p.id, 'done'))
      await vi.advanceTimersByTimeAsync(60)
      await vi.runAllTimersAsync()
      // isBuilding guard short-circuits before resolveProject is ever called
      expect(secondAnalyze).toBe(0)
      // and crucially: analyze is NOT re-entered while the first build is in flight
      expect(analyzeCalls).toBe(1)
    } finally {
      off()
    }
  })

  it('does nothing when GRAPH_AUTO_REINDEX=0', async () => {
    const p = insertProject(tmpRepo())
    process.env.GRAPH_AUTO_REINDEX = '0'
    let resolved = 0
    const off = registerGraphAutoReindex(() => { resolved++; return p }, 50)
    try {
      eventBus.emitRunUpdate(makeRun(p.id, 'done'))
      await vi.advanceTimersByTimeAsync(60)
      await vi.runAllTimersAsync()
      expect(resolved).toBe(0)
    } finally {
      off()
    }
  })

  it('ignores non-terminal / non-done statuses', async () => {
    const p = insertProject(tmpRepo())
    let resolved = 0
    const off = registerGraphAutoReindex(() => { resolved++; return p }, 50)
    try {
      eventBus.emitRunUpdate(makeRun(p.id, 'running'))
      eventBus.emitRunUpdate(makeRun(p.id, 'error'))
      await vi.advanceTimersByTimeAsync(60)
      await vi.runAllTimersAsync()
      expect(resolved).toBe(0)
    } finally {
      off()
    }
  })
})

// ── markStale (Wave 2) ──────────────────────────────────────────────────────────

describe('markStale', () => {
  it('flips a ready graph to stale (lastCommit=null) and broadcasts', async () => {
    const dir = tmpRepo()
    const p = insertProject(dir)
    __setAnalyzeRunner(async (cwd) => writeGitnexusMeta(cwd, 'c1', 2, 2))
    await buildGraph(p)
    expect(getGraphMeta(p.id).status).toBe('ready')

    const seen: WsMessage[] = []
    const unsub = eventBus.onBroadcast(m => seen.push(m))
    markStale(p.id)
    unsub()

    expect(getGraphMeta(p.id).lastCommit).toBeNull()
    expect(await isGraphStale(p)).toBe(true)
    expect(seen.some(m => m.type === 'graph_update')).toBe(true)
  })

  it('is a no-op for a never-built graph', () => {
    const p = insertProject(tmpRepo())
    markStale(p.id)
    expect(getGraphMeta(p.id).status).toBe('idle')
  })
})

/** Build a Run for emitRunUpdate AND insert its row first, so emitRunUpdate's
 *  real `UPDATE runs ...` hits an existing row (matching production) rather than
 *  no-op'ing on a fabricated id. Reuses the insertRun helper above. */
function makeRun(projectId: string, status: string): import('@k/shared').Run {
  const id = insertRun(projectId, 'x', status)
  return {
    id, prompt: 'x', cwd: '/tmp', status: status as import('@k/shared').Run['status'],
    provider: 'claude', model: 'claude-sonnet-4-6',
    tokensIn: 0, tokensOut: 0, costUsd: 0, projectId, createdAt: Date.now(),
  }
}
