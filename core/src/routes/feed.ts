import type { FastifyInstance } from 'fastify'
import type { FeedItem, FeedKind, FeedPayload, RunStatus } from '@k/shared'
import { FeedKindSchema } from '@k/shared'
import { db } from '../db.js'

const listRunHeads = db.prepare(`
  SELECT r.id, r.prompt, r.status, r.model, r.created_at, r.ended_at, r.project_id, p.name AS project_name
  FROM runs r LEFT JOIN projects p ON p.id = r.project_id
  ORDER BY COALESCE(r.ended_at, r.created_at) DESC
  LIMIT ?
`)
const listReviewReadyNotifs = db.prepare(`
  SELECT n.id, n.title, n.created_at, n.run_id, n.project_id, p.name AS project_name, r.status AS run_status
  FROM notifications n
  LEFT JOIN runs r ON r.id = n.run_id
  LEFT JOIN projects p ON p.id = n.project_id
  WHERE n.event_key = 'run_review_ready'
  ORDER BY n.created_at DESC
  LIMIT ?
`)
const listVerifyMilestones = db.prepare(`
  SELECT v.run_id, v.status AS verify_status, v.completed_at, r.status AS run_status,
         r.prompt, r.project_id, p.name AS project_name
  FROM verify_results v
  JOIN runs r ON r.id = v.run_id
  LEFT JOIN projects p ON p.id = r.project_id
  WHERE v.status IN ('pass', 'fail') AND v.completed_at IS NOT NULL
  ORDER BY v.completed_at DESC
  LIMIT ?
`)
const listPrCache = db.prepare(`
  SELECT g.project_id, g.payload, g.fetched_at, p.name AS project_name
  FROM github_cache g LEFT JOIN projects p ON p.id = g.project_id
  WHERE g.kind = 'pr'
  LIMIT ?
`)

const SOURCE_CAP = 500

function firstLine(prompt: unknown): string { return String(prompt ?? '').split('\n')[0].slice(0, 120) }

interface CachedPr { number: number; title: string }
/** OPEN PRs from github_cache -> 'pr' feed items (ts = the row's shared fetched_at). */
function prItems(): FeedItem[] {
  const out: FeedItem[] = []
  for (const row of listPrCache.all(SOURCE_CAP) as Array<{ project_id: string; payload: string; fetched_at: number; project_name: string | null }>) {
    let prs: unknown
    try { prs = JSON.parse(row.payload) } catch { continue }
    if (!Array.isArray(prs)) continue
    for (const raw of (prs as CachedPr[]).slice(0, SOURCE_CAP)) {
      if (typeof raw?.number !== 'number' || typeof raw?.title !== 'string') continue
      out.push({
        id: `pr:${row.project_id}:${raw.number}`, kind: 'pr', ts: Number(row.fetched_at),
        runId: null, runStatus: null,
        projectId: row.project_id, projectName: row.project_name != null ? String(row.project_name) : null,
        title: raw.title, detail: `#${raw.number}`,
      })
    }
  }
  return out
}

/** Map a run's CURRENT status to its head milestone kind. */
function headKind(status: RunStatus): FeedKind {
  switch (status) {
    case 'queued': case 'running': return 'dispatch'
    case 'awaiting_plan': return 'plan_gate'
    case 'awaiting_input': return 'park'
    case 'done': return 'done'
    case 'error': case 'killed': case 'interrupted': return 'failure'
    default: return 'dispatch'
  }
}

function zeroCounts(): Record<FeedKind, number> {
  return Object.fromEntries(FeedKindSchema.options.map(k => [k, 0])) as Record<FeedKind, number>
}

/** E-09 Org Timeline routes (read-time union projection — D-085: a QUERY, never a table). */
export async function feedRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string | string[]; kinds?: string | string[] } }>('/api/feed', async (req, reply) => {
    // Query params arrive as a string, or as a string[] on a repeated key (?kinds=a&kinds=b) —
    // normalize both shapes so a hand-built URL can never crash the read-only endpoint.
    const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit
    const limitNum = Number(limitRaw)
    const limit = limitRaw !== undefined && Number.isFinite(limitNum)
      ? Math.max(1, Math.min(500, Math.trunc(limitNum)))   // a provided limit is clamped into 1..500
      : 100                                                 // absent/non-numeric -> default 100
    const kindsRaw = Array.isArray(req.query.kinds) ? req.query.kinds.join(',') : req.query.kinds
    const kindsFilter: Set<FeedKind> | null = kindsRaw
      ? new Set(kindsRaw.split(',').map(s => s.trim()).filter((s): s is FeedKind => (FeedKindSchema.options as string[]).includes(s)))
      : null

    const items: FeedItem[] = []

    for (const r of listRunHeads.all(SOURCE_CAP) as Record<string, unknown>[]) {
      const status = String(r.status) as RunStatus
      items.push({
        id: `run:${r.id}:${status}`, kind: headKind(status),
        ts: Number(r.ended_at ?? r.created_at), runId: String(r.id), runStatus: status,
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: firstLine(r.prompt), detail: r.model != null ? String(r.model) : null,
      })
    }
    for (const n of listReviewReadyNotifs.all(SOURCE_CAP) as Record<string, unknown>[]) {
      items.push({
        id: `notif:${n.id}:review_ready`, kind: 'review_ready', ts: Number(n.created_at),
        runId: n.run_id != null ? String(n.run_id) : null,
        runStatus: n.run_status != null ? (String(n.run_status) as RunStatus) : null,
        projectId: n.project_id != null ? String(n.project_id) : null,
        projectName: n.project_name != null ? String(n.project_name) : null,
        title: String(n.title), detail: null,
      })
    }
    for (const v of listVerifyMilestones.all(SOURCE_CAP) as Record<string, unknown>[]) {
      items.push({
        id: `verify:${v.run_id}:${v.verify_status}`,
        kind: v.verify_status === 'pass' ? 'verify_pass' : 'verify_fail', ts: Number(v.completed_at),
        runId: String(v.run_id), runStatus: v.run_status != null ? (String(v.run_status) as RunStatus) : null,
        projectId: v.project_id != null ? String(v.project_id) : null,
        projectName: v.project_name != null ? String(v.project_name) : null,
        title: firstLine(v.prompt), detail: v.verify_status === 'pass' ? 'verified' : 'verify failed',
      })
    }
    for (const g of prItems()) items.push(g)

    const assembled = kindsFilter ? items.filter(i => kindsFilter.has(i.kind)) : items
    assembled.sort((a, b) => b.ts - a.ts)
    const counts = zeroCounts()
    for (const i of assembled) counts[i.kind]++
    const total = assembled.length
    const payload: FeedPayload = { items: assembled.slice(0, limit), counts, total }
    return reply.send(payload)
  })
}
