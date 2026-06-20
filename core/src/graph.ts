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
import { readFile } from 'fs/promises'
import path from 'path'
import type { Project, ProjectGraphMeta } from '@k/shared'
import { projectGraphsDb } from './db.js'
import { eventBus } from './events.js'

// ── analyze runner (swappable seam) ─────────────────────────────────────────────

export type AnalyzeRunner = (cwd: string) => Promise<void>

const ANALYZE_TIMEOUT_MS = Number(process.env.GITNEXUS_TIMEOUT_MS) || 600_000

/** Real runner: `npx gitnexus analyze` in the project dir. */
const defaultAnalyze: AnalyzeRunner = async (cwd) => {
  await execa('npx', ['gitnexus', 'analyze'], { cwd, timeout: ANALYZE_TIMEOUT_MS })
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
