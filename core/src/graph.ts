/**
 * Knowledge Graph engine (Phase H).
 *
 * K orchestrates `npx gitnexus analyze` per project to (re)build its code graph,
 * tracks build state in the `project_graphs` table, and broadcasts `graph_update`
 * WS messages via the EventBus. The graph data itself lives in the project's
 * .gitnexus/ dir (read by the GET /graph route); this module owns build state +
 * freshness only.
 *
 * The analyze runner is a swappable module seam (__setAnalyzeRunner) so the build
 * lifecycle, in-flight guard, and broadcast logic are unit-testable without ever
 * invoking the real GitNexus CLI (CI must never shell out to it).
 */

import { execa } from 'execa'
import { readFile, rename, writeFile } from 'fs/promises'
import path from 'path'
import type { Finding, GraphNodeEnrichment, Project, ProjectGraphMeta, Run } from '@k/shared'
import { artifactsDb, db, projectGraphsDb, rowToReport, verificationDb } from './db.js'
import { eventBus } from './events.js'
import { REPO_ROOT } from './supervisor.js'

// ── analyze runner (swappable seam) ─────────────────────────────────────────────
//
// The seam's contract is "produce the .gitnexus artifacts": run analyze AND export
// a renderable graph.json. The real impl shells out (analyze → cypher → writeFile);
// CI injects a fake that just writes fixture meta.json + graph.json. Keeping the
// whole real-CLI path behind one seam means buildGraph never shells out in tests.

export type AnalyzeRunner = (cwd: string) => Promise<void>

const ANALYZE_TIMEOUT_MS = Number(process.env.GITNEXUS_TIMEOUT_MS) || 600_000
const CYPHER_TIMEOUT_MS = Number(process.env.GITNEXUS_CYPHER_TIMEOUT_MS) || 120_000

// ── pure cypher parsing / transform (no I/O — unit-tested directly) ──────────────

/**
 * Parse `gitnexus cypher` stdout into the array of single-column cell values.
 *
 * The CLI prints `{ "markdown": "| col |\n| --- |\n| <cell> |\n...", "row_count": N }`.
 * For a SINGLE-column RETURN, each data row is `| <json> |` where <json> is one JSON
 * value — safe to JSON.parse even if it contains `|`, because there's exactly one
 * column (no inner cell delimiter to confuse us). We drop the header + separator
 * rows and JSON.parse each remaining cell.
 */
export function parseCypherRows(stdout: string): unknown[] {
  const outer = JSON.parse(stdout) as { markdown?: unknown }
  const md = typeof outer.markdown === 'string' ? outer.markdown : ''
  const lines = md.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  const rows: unknown[] = []
  for (const line of lines) {
    if (!line.startsWith('|')) continue
    // Strip the single leading + trailing pipe, leaving the one column's cell.
    const cell = line.replace(/^\|/, '').replace(/\|$/, '').trim()
    if (cell === '' || cell === 'n' || cell === 'e' || /^-+$/.test(cell)) continue // header/separator
    try {
      rows.push(JSON.parse(cell))
    } catch {
      // A cell that isn't JSON (an unexpected header label) is skipped, not fatal.
    }
  }
  return rows
}

type RawNode = Record<string, unknown>
type RawEdge = Record<string, unknown>

export interface GraphJson {
  nodes: Array<{ id: string; name: unknown; label: string; type: unknown; file: unknown; group: unknown }>
  links: Array<{ source: unknown; target: unknown; type: unknown }>
}

/**
 * Transform raw cypher node/edge rows into the lean shape the GET /graph route +
 * UI consume. Drops the embedding + the many null columns; keeps `id` verbatim so
 * links resolve. `_label` becomes both `type` and `group` (the UI colors by these).
 * Label falls back to id only when name is unset OR empty-string (deliberate: an
 * empty name is not a usable label).
 */
export function toGraphJson(nodeRows: unknown[], edgeRows: unknown[]): GraphJson {
  const nodes = (nodeRows as RawNode[])
    .filter(n => n && typeof n === 'object' && typeof n.id === 'string')
    .map(n => {
      const name = n.name
      const label = typeof name === 'string' && name.trim() !== '' ? name : String(n.id)
      return {
        id: String(n.id),
        name: name ?? null,
        label,
        type: n._label ?? null,
        file: n.filePath ?? null,
        group: n._label ?? null,
      }
    })
  const links = (edgeRows as RawEdge[])
    .filter(e => e && typeof e === 'object' && e.source != null && e.target != null)
    .map(e => ({ source: e.source, target: e.target, type: e.type ?? null }))
  return { nodes, links }
}

// ── repo-name resolution (the global registry can hold multiple repos) ───────────

/**
 * Resolve the `--repo <name>` gitnexus needs for `cwd`. Prefers the basename of
 * `.gitnexus/meta.json`'s repoPath (authoritative); falls back to parsing
 * `gitnexus list` and matching the entry whose Path === cwd (case-insensitive,
 * normalized) — an exact path match, NOT substring, so "K" can't match "KAT".
 */
export async function resolveRepoName(cwd: string): Promise<string> {
  try {
    const meta = JSON.parse(await readFile(path.join(cwd, '.gitnexus', 'meta.json'), 'utf8')) as { repoPath?: string }
    if (typeof meta.repoPath === 'string' && meta.repoPath.trim() !== '') {
      return path.basename(meta.repoPath)
    }
  } catch {
    // fall through to `gitnexus list`
  }
  const { stdout } = await execa('npx', ['gitnexus', 'list'], { cwd, timeout: 30_000 })
  const want = path.resolve(cwd).toLowerCase()
  // Entries look like: "  <Name>\n    Path:    <path>\n ..."
  const lines = stdout.split('\n')
  let currentName: string | null = null
  for (const line of lines) {
    const nameMatch = /^\s{0,4}(\S.*?)\s*$/.exec(line)
    const pathMatch = /^\s*Path:\s*(.+?)\s*$/.exec(line)
    if (pathMatch) {
      const p = path.resolve(pathMatch[1]).toLowerCase()
      if (p === want && currentName) return currentName
    } else if (nameMatch && !/:/.test(line) && line.trim() !== '' && !/^\s*Indexed Repositories/.test(line)) {
      currentName = nameMatch[1].trim()
    }
  }
  throw new Error(`could not resolve gitnexus repo name for ${cwd}`)
}

/** Run a single-column cypher query and return its parsed rows. */
async function runCypher(cwd: string, repo: string, query: string): Promise<unknown[]> {
  const { stdout } = await execa('npx', ['gitnexus', 'cypher', '--repo', repo, query], {
    cwd,
    timeout: CYPHER_TIMEOUT_MS,
  })
  return parseCypherRows(stdout)
}

/**
 * Export `.gitnexus/graph.json` from the indexed gitnexus DB via two cypher
 * queries. Separated out (and exported) so the real export path is exercised
 * live, but only the real runner calls it — CI's fake runner writes a fixture.
 */
export async function exportGraphJson(cwd: string): Promise<GraphJson> {
  const repo = await resolveRepoName(cwd)
  const [nodeRows, edgeRows] = await Promise.all([
    runCypher(cwd, repo, 'MATCH (n) RETURN n'),
    runCypher(cwd, repo, 'MATCH (a)-[r]->(b) RETURN {source: a.id, target: b.id, type: label(r)} AS e'),
  ])
  const graph = toGraphJson(nodeRows, edgeRows)
  const finalPath = path.join(cwd, '.gitnexus', 'graph.json')
  const tmpPath = finalPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(graph))
  await rename(tmpPath, finalPath)
  return graph
}

/**
 * Real runner: `npx gitnexus analyze --skip-agents-md` (the --skip-agents-md flag
 * stops every build from rewriting CLAUDE.md/AGENTS.md), then export graph.json
 * from the freshly-indexed DB so the GET /graph route has renderable data.
 */
const defaultAnalyze: AnalyzeRunner = async (cwd) => {
  await execa('npx', ['gitnexus', 'analyze', '--skip-agents-md'], { cwd, timeout: ANALYZE_TIMEOUT_MS })
  await exportGraphJson(cwd)
}

let analyzeRunner: AnalyzeRunner = defaultAnalyze

/** Test seam — override the analyze command (mirrors github.ts's __pollOnce). */
export function __setAnalyzeRunner(fn: AnalyzeRunner | null): void {
  analyzeRunner = fn ?? defaultAnalyze
}

// ── meta read/write ─────────────────────────────────────────────────────────────

function idleMeta(projectId: string): ProjectGraphMeta {
  return { projectId, status: 'idle', builtAt: null, lastCommit: null, nodeCount: 0, edgeCount: 0, error: null }
}

function rowToMeta(r: Record<string, unknown>): ProjectGraphMeta {
  return {
    projectId: String(r.project_id),
    status: r.status as ProjectGraphMeta['status'],
    builtAt: r.built_at == null ? null : Number(r.built_at),
    lastCommit: r.last_commit == null ? null : String(r.last_commit),
    nodeCount: Number(r.node_count ?? 0),
    edgeCount: Number(r.edge_count ?? 0),
    error: r.error == null ? null : String(r.error),
  }
}

export function getGraphMeta(projectId: string): ProjectGraphMeta {
  const row = projectGraphsDb.getProjectGraph.get(projectId) as Record<string, unknown> | undefined
  return row ? rowToMeta(row) : idleMeta(projectId)
}

/** Persist meta and broadcast a graph_update so connected clients react live. */
function writeMeta(meta: ProjectGraphMeta): void {
  projectGraphsDb.upsertProjectGraph.run({
    projectId: meta.projectId,
    status: meta.status,
    builtAt: meta.builtAt,
    lastCommit: meta.lastCommit,
    nodeCount: meta.nodeCount,
    edgeCount: meta.edgeCount,
    error: meta.error,
    updatedAt: Date.now(),
  })
  eventBus.broadcast({ type: 'graph_update', projectId: meta.projectId, meta })
}

// ── git + gitnexus artifact reads ───────────────────────────────────────────────

/** Current HEAD sha of a repo, or null if not a git repo / git unavailable. */
export async function currentHead(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: localPath, timeout: 10_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

interface GraphStats {
  lastCommit: string | null
  nodeCount: number
  edgeCount: number
}

/**
 * Read build stats from the project's .gitnexus artifacts. Prefers meta.json
 * (authoritative lastCommit + stats); falls back to counting graph.json. Throws
 * if neither is present (a build that produced nothing is an error).
 */
async function readGraphStats(localPath: string): Promise<GraphStats> {
  const dir = path.join(localPath, '.gitnexus')
  try {
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as {
      lastCommit?: string
      stats?: { nodes?: number; edges?: number }
    }
    return {
      lastCommit: meta.lastCommit ?? null,
      nodeCount: Number(meta.stats?.nodes ?? 0),
      edgeCount: Number(meta.stats?.edges ?? 0),
    }
  } catch {
    // No meta.json — fall back to graph.json node/edge counts.
    const data = JSON.parse(await readFile(path.join(dir, 'graph.json'), 'utf8')) as {
      nodes?: unknown[]
      edges?: unknown[]
      links?: unknown[]
    }
    return {
      lastCommit: null,
      nodeCount: (data.nodes ?? []).length,
      edgeCount: (data.links ?? data.edges ?? []).length,
    }
  }
}

// ── build ───────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>()

export function isBuilding(projectId: string): boolean {
  return inFlight.has(projectId)
}

/**
 * Build (or rebuild) a project's knowledge graph. Idempotent under concurrency:
 * a second call while a build is in flight is a no-op that returns current meta.
 * Never throws — analyze failures land as status 'error' on the meta.
 */
export async function buildGraph(project: Project): Promise<ProjectGraphMeta> {
  if (inFlight.has(project.id)) return getGraphMeta(project.id)
  inFlight.add(project.id)

  // Flip to 'building' synchronously (before the first await) so a POST handler
  // that fires this and immediately reads meta observes the building state.
  const prev = getGraphMeta(project.id)
  writeMeta({ ...prev, status: 'building', error: null })

  try {
    await analyzeRunner(project.localPath)
    const stats = await readGraphStats(project.localPath)
    const ready: ProjectGraphMeta = {
      projectId: project.id,
      status: 'ready',
      builtAt: Date.now(),
      lastCommit: stats.lastCommit,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      error: null,
    }
    writeMeta(ready)
    return ready
  } catch (e) {
    const errored: ProjectGraphMeta = {
      ...getGraphMeta(project.id),
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    }
    writeMeta(errored)
    return errored
  } finally {
    inFlight.delete(project.id)
  }
}

/**
 * Freshness check: stale when the graph was never built, has no recorded commit,
 * or HEAD has moved since the last build. Best-effort — git/fs errors degrade to
 * "not stale" so a transient failure never nags the UI.
 */
export async function isGraphStale(project: Project, meta = getGraphMeta(project.id)): Promise<boolean> {
  if (meta.status !== 'ready' || !meta.lastCommit) return true
  const head = await currentHead(project.localPath)
  if (!head) return false
  return head !== meta.lastCommit
}

// ── live node enrichment ─────────────────────────────────────────────────────────
// Best-effort facts attached to each graph node, derived from EXISTING harness
// data. Cheap by construction: we read each per-project source ONCE per request
// (recent runs, latest verification report, compiled bible md), build an
// enricher closure over those snapshots, then match each node against them in
// memory — no per-node DB/FS work. Every source is independently guarded so an
// absent/garbled one omits its fact rather than failing the request.

// Cap how many recent runs we scan for the last-touched match — keeps the per
// request cost bounded regardless of run history size.
const ENRICH_RUN_LIMIT = 50

/** A node's identifying strings used to match it against text sources. Prefers a
 *  real file path (node.file / node.path), falling back to label/id. Lower-cased
 *  + filtered to non-trivial tokens so a 1-char id can't match everything. */
function nodeNeedles(node: Record<string, unknown>): string[] {
  const raw = [node.file, node.path, node.label, node.id, node.name]
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim().toLowerCase()
    if (s.length >= 3 && !out.includes(s)) out.push(s)
  }
  return out
}

/** True when this project IS the harness repo itself (localPath resolves to the
 *  supervisor's REPO_ROOT). The `project-bible` artifact is a single GLOBAL slug —
 *  the harness's OWN compiled bible — so `inBible` is only meaningful for the
 *  harness project. (Per-project bibles don't exist yet.) */
function isHarnessProject(project: Project): boolean {
  try {
    return path.resolve(project.localPath) === path.resolve(REPO_ROOT)
  } catch {
    return false
  }
}

/** Build a per-request enricher over project-scoped snapshots. Returns a function
 *  mapping a node → its enrichment (or undefined when no fact applies). All source
 *  reads are guarded; a failed source simply contributes nothing. */
function buildEnricher(project: Project): (node: Record<string, unknown>) => GraphNodeEnrichment | undefined {
  const projectId = project.id
  // ── source 1: recent runs (prompt references the node) ──────────────────────
  // Newest-first so the FIRST prompt match per node is the most recent run.
  let runs: Array<{ id: string; prompt: string; status: string; createdAt: number }> = []
  try {
    runs = (db
      .prepare(`SELECT id, prompt, status, created_at FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(projectId, ENRICH_RUN_LIMIT) as Array<Record<string, unknown>>)
      .map(r => ({ id: String(r.id), prompt: String(r.prompt ?? '').toLowerCase(), status: String(r.status), createdAt: Number(r.created_at) }))
  } catch { runs = [] }

  // ── source 2: latest verification report findings ───────────────────────────
  let findings: Finding[] = []
  try {
    const row = (verificationDb.listVerificationReports.all(projectId) as Array<Record<string, unknown>>)[0]
    if (row) findings = rowToReport(row).findings
  } catch { findings = [] }
  const findingMsgs = findings.map(f => ({ f, msg: f.message.toLowerCase() }))

  // ── source 3: compiled project bible markdown ───────────────────────────────
  // Only meaningful for the harness project: `project-bible` is a single global
  // slug holding the harness's OWN bible. For any other project, matching nodes
  // against it would spuriously flag everything as inBible, so we skip it.
  let bibleMd = ''
  if (isHarnessProject(project)) {
    try {
      const row = artifactsDb.getArtifact.get('project-bible') as Record<string, unknown> | undefined
      if (row && typeof row.md === 'string') bibleMd = row.md.toLowerCase()
    } catch { bibleMd = '' }
  }

  return (node) => {
    const needles = nodeNeedles(node)
    if (needles.length === 0) return undefined
    const enrichment: GraphNodeEnrichment = {}

    const run = runs.find(r => needles.some(n => r.prompt.includes(n)))
    if (run) enrichment.lastRun = { runId: run.id, status: run.status, createdAt: run.createdAt }

    const matchedFindings = findingMsgs.filter(({ msg }) => needles.some(n => msg.includes(n))).map(({ f }) => f)
    if (matchedFindings.length > 0) enrichment.findings = matchedFindings

    if (bibleMd && needles.some(n => bibleMd.includes(n))) enrichment.inBible = true

    return Object.keys(enrichment).length > 0 ? enrichment : undefined
  }
}

/**
 * Attach best-effort `enrichment` to each graph node from existing harness data.
 * Never throws — a source that is absent or errors simply contributes no fact, so
 * the GET /graph response degrades gracefully to the un-enriched nodes.
 */
export function enrichNodes(project: Project, nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let enrich: ReturnType<typeof buildEnricher>
  try {
    enrich = buildEnricher(project)
  } catch {
    return nodes
  }
  return nodes.map(node => {
    try {
      const enrichment = enrich(node)
      return enrichment ? { ...node, enrichment } : node
    } catch {
      return node
    }
  })
}

// ── auto-reindex (EventBus subscriber) ───────────────────────────────────────────
// When a run that touched a project's files completes, the graph for that project
// is now potentially stale. registerGraphAutoReindex() listens for run-completion
// events on the EventBus and triggers a DEBOUNCED, GUARDED rebuild: a burst of
// completions collapses into one rebuild, and the existing in-flight guard in
// buildGraph prevents re-triggering a build already running.

// Opt-out via env (default ON). Read lazily so tests can toggle it per-call.
function autoReindexEnabled(): boolean {
  return process.env.GRAPH_AUTO_REINDEX !== '0'
}

const DEFAULT_REINDEX_DEBOUNCE_MS = Number(process.env.GRAPH_REINDEX_DEBOUNCE_MS) || 5_000

// Only a 'done' run triggers a reindex. We deliberately EXCLUDE 'error'/'killed':
// a run that errored or was killed may not have written files, and repeated
// failures would otherwise spam rebuilds. We accept a missed reindex (the user
// can rebuild manually, and the next successful run will reindex) over churning.
const REINDEX_TRIGGER_STATUSES = new Set(['done'])

type ProjectResolver = (projectId: string) => Project | null

/**
 * Subscribe to run-completion events and debounce-trigger a per-project graph
 * rebuild. Returns an unsubscribe function (also clears pending timers) so the
 * subscription is testable in isolation.
 *
 * @param resolveProject  maps a projectId → Project (the route layer's getProject)
 * @param debounceMs      collapse-window per project (injectable for tests)
 */
export function registerGraphAutoReindex(
  resolveProject: ProjectResolver,
  debounceMs: number = DEFAULT_REINDEX_DEBOUNCE_MS,
): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const off = eventBus.onRunUpdate((run: Run) => {
    if (!autoReindexEnabled()) return
    if (!run.projectId || !REINDEX_TRIGGER_STATUSES.has(run.status)) return
    const projectId = run.projectId

    // Mark stale immediately so the UI reflects "graph behind HEAD" before the
    // debounced rebuild lands; broadcasts a graph_update via writeMeta.
    markStale(projectId)

    // Debounce: a burst of completions for one project collapses to one rebuild.
    const existing = timers.get(projectId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      timers.delete(projectId)
      // The in-flight guard inside buildGraph makes a concurrent build a no-op.
      if (isBuilding(projectId)) return
      const project = resolveProject(projectId)
      if (!project) return
      void buildGraph(project).catch(() => { /* errors land on meta as status:'error' */ })
    }, debounceMs)
    // A pending debounce must not hold the event loop open (mirrors router.ts).
    t.unref?.()
    timers.set(projectId, t)
  })

  return () => {
    off()
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
}

/**
 * Mark a built graph stale without rebuilding: flip a 'ready' meta back so the UI
 * shows the graph is behind HEAD. No-op for a graph that was never built (status
 * stays idle/error/building). Broadcasts the change via writeMeta.
 */
export function markStale(projectId: string): void {
  const meta = getGraphMeta(projectId)
  if (meta.status !== 'ready') return
  // lastCommit=null makes isGraphStale() return true deterministically, and
  // keeps status 'ready' so existing graph data still renders while stale.
  writeMeta({ ...meta, lastCommit: null })
}
