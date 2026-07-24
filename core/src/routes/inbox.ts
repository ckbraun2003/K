import type { FastifyInstance } from 'fastify'
import { PlanDocSchema, type InboxCounts, type InboxItem, type InboxPayload, type ProposalSource, type VerifyStatus } from '@k/shared'
import { db, runsDb, proposalsDb } from '../db.js'
import { eventBus } from '../events.js'
import { sendError } from './http-errors.js'

// Local prepares (capabilities.ts:72 precedent): the union is an inbox-only read
// shape — db.ts's shared maps stay W0-frozen.
const listPlanParked = db.prepare(`
  SELECT r.id, r.prompt, r.project_id, p.name AS project_name,
         rp.plan, rp.edited, rp.created_at AS ts
  FROM runs r
  JOIN run_plans rp ON rp.run_id = r.id
  LEFT JOIN projects p ON p.id = r.project_id
  WHERE r.status = 'awaiting_plan'
  ORDER BY rp.created_at DESC
`)
// ui-adjustments R4 (D2): every interactive turn still parks at awaiting_input
// (supervisor.ts, untouched) — the card now surfaces ONLY when the agent
// explicitly asked via the request_input kstore tool AND that ask is still
// unanswered (no later 'running' status event, i.e. no resume since). One row
// per run (correlated subqueries pull the LATEST input_request's question/raw,
// so two asks for one run still produce exactly one card); kept in exact sync
// with db.ts's hasUnansweredInputRequest (notify.ts's twin predicate).
const listInputParked = db.prepare(`
  SELECT r.id, r.prompt, r.model, r.created_at AS ts, r.project_id, p.name AS project_name,
    (SELECT e.text FROM events e WHERE e.run_id=r.id AND e.type='input_request' ORDER BY e.ts DESC, e.seq DESC LIMIT 1) AS question,
    (SELECT e.raw  FROM events e WHERE e.run_id=r.id AND e.type='input_request' ORDER BY e.ts DESC, e.seq DESC LIMIT 1) AS input_raw
  FROM runs r LEFT JOIN projects p ON p.id = r.project_id
  WHERE r.status='awaiting_input'
    AND EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.type='input_request'
      AND e.ts > COALESCE((SELECT MAX(s.ts) FROM events s WHERE s.run_id=r.id AND s.type='status' AND s.text='running'), 0))
  ORDER BY r.created_at DESC
`)
const listPendingLessons = db.prepare(`
  SELECT m.id, m.lesson, m.created_at AS ts, pr.name AS profile_name
  FROM agent_memory m LEFT JOIN agent_profiles pr ON m.profile_id = pr.id
  WHERE m.status = 'pending'
  ORDER BY m.created_at DESC
`)
// Untrusted = the capabilities.ts:158 predicate; not missing; not hash-dismissed.
const listUntrustedMcp = db.prepare(`
  SELECT s.qualified_key, s.name, s.source_kind, s.command,
         COALESCE(s.last_scanned_at, s.discovered_at) AS ts, s.project_id, p.name AS project_name
  FROM host_mcp_servers s LEFT JOIN projects p ON p.id = s.project_id
  WHERE s.status != 'missing'
    AND (s.trusted_hash IS NULL OR s.trusted_hash != s.config_hash)
    AND (s.inbox_dismissed_hash IS NULL OR s.inbox_dismissed_hash != s.config_hash)
  ORDER BY ts DESC
`)
// Review-ready = done project run, unreviewed, with a checkpoint chain (SQL-only
// EXISTS — never a per-run git call). Items capped at 20; the COUNT twin is honest.
const listReviewReady = db.prepare(`
  SELECT r.id, r.prompt, COALESCE(r.ended_at, r.created_at) AS ts, r.project_id,
         p.name AS project_name, v.status AS verify_status
  FROM runs r
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN verify_results v ON v.run_id = r.id
  WHERE r.status = 'done' AND r.project_id IS NOT NULL AND r.reviewed_at IS NULL
    AND EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'checkpoint')
  ORDER BY ts DESC
  LIMIT 20
`)
const countReviewReady = db.prepare(`
  SELECT COUNT(*) AS n FROM runs r
  WHERE r.status = 'done' AND r.project_id IS NOT NULL AND r.reviewed_at IS NULL
    AND EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'checkpoint')
`)
// Dismiss = pin the CURRENT config hash (trusted_hash idiom) — drift re-surfaces.
const dismissMcp = db.prepare(
  `UPDATE host_mcp_servers SET inbox_dismissed_hash = config_hash WHERE qualified_key = ?`,
)

function firstLine(prompt: unknown): string {
  return String(prompt).split('\n')[0].slice(0, 120)
}

const INPUT_KINDS = new Set(['question', 'verification', 'feedback'])
type InputKind = 'question' | 'verification' | 'feedback'
/** Defensive parse of an input_request event's `raw` JSON — a garbled/absent value
 *  must not throw or crash the union (mirrors parseProjects's mgmt.ts precedent). */
function inputRequestKind(raw: unknown): InputKind | undefined {
  if (raw == null) return undefined
  try {
    const parsed = JSON.parse(String(raw)) as { kind?: unknown }
    return typeof parsed.kind === 'string' && INPUT_KINDS.has(parsed.kind) ? (parsed.kind as InputKind) : undefined
  } catch { return undefined }
}

function planMeta(planJson: unknown): { risk: 'low' | 'medium' | 'high' | null; steps: number | null } {
  if (planJson == null) return { risk: null, steps: null }
  try {
    const parsed = PlanDocSchema.safeParse(JSON.parse(String(planJson)))
    return parsed.success ? { risk: parsed.data.risk, steps: parsed.data.steps.length } : { risk: null, steps: null }
  } catch { return { risk: null, steps: null } }
}

/** E-05 Approvals Inbox routes (union list / dismissals). */
export async function inboxRoutes(app: FastifyInstance) {
  // GET /api/inbox — the five-source needs-YOU union (D-081: a QUERY, never a table).
  app.get('/api/inbox', async (_req, reply) => {
    const items: InboxItem[] = []
    for (const r of listPlanParked.all() as Record<string, unknown>[]) {
      const meta = planMeta(r.plan)
      items.push({ kind: 'plan_pending', id: `plan_pending:${r.id}`, ts: Number(r.ts),
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: firstLine(r.prompt), runId: String(r.id), risk: meta.risk, steps: meta.steps,
        edited: r.edited === 1 })
    }
    for (const r of listInputParked.all() as Record<string, unknown>[]) {
      items.push({ kind: 'input_needed', id: `input_needed:${r.id}`, ts: Number(r.ts),
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: firstLine(r.prompt), runId: String(r.id), model: String(r.model),
        question: r.question != null ? String(r.question) : undefined,
        inputKind: inputRequestKind(r.input_raw) })
    }
    for (const r of listPendingLessons.all() as Record<string, unknown>[]) {
      items.push({ kind: 'lesson_pending', id: `lesson_pending:${r.id}`, ts: Number(r.ts),
        projectId: null, projectName: null,
        title: String(r.lesson).slice(0, 200), lessonId: String(r.id),
        profileName: r.profile_name != null ? String(r.profile_name) : null })
    }
    for (const r of listUntrustedMcp.all() as Record<string, unknown>[]) {
      items.push({ kind: 'mcp_trust', id: `mcp_trust:${r.qualified_key}`, ts: Number(r.ts),
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: String(r.name), qualifiedKey: String(r.qualified_key),
        sourceKind: r.source_kind as 'claude-user' | 'claude-project', command: String(r.command) })
    }
    for (const r of listReviewReady.all() as Record<string, unknown>[]) {
      items.push({ kind: 'review_ready', id: `review_ready:${r.id}`, ts: Number(r.ts),
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: firstLine(r.prompt), runId: String(r.id),
        verifyStatus: r.verify_status != null ? (String(r.verify_status) as VerifyStatus) : null })
    }
    // E-14: blocked+sourced org work_items awaiting operator approval (→ open/backlog)
    // or dismissal (→ cancelled). listProposals joins the project name for the card.
    for (const r of proposalsDb.listProposals.all(50) as Record<string, unknown>[]) {
      items.push({ kind: 'proposal', id: `proposal:${r.id}`, ts: Number(r.created_at),
        projectId: r.project_id != null ? String(r.project_id) : null,
        projectName: r.project_name != null ? String(r.project_name) : null,
        title: String(r.title), workItemId: String(r.id),
        source: r.source as ProposalSource, body: r.body != null ? String(r.body) : null })
    }
    items.sort((a, b) => b.ts - a.ts)
    const counts: InboxCounts = {
      plan_pending: items.filter(i => i.kind === 'plan_pending').length,
      input_needed: items.filter(i => i.kind === 'input_needed').length,
      lesson_pending: items.filter(i => i.kind === 'lesson_pending').length,
      mcp_trust: items.filter(i => i.kind === 'mcp_trust').length,
      review_ready: (countReviewReady.get() as { n: number }).n, // honest uncapped count
      // E-14: open (blocked, sourced) proposals. Count only for now — B3 adds the cards.
      proposal: (proposalsDb.countOpenProposals.get() as { n: number }).n,
    }
    const payload: InboxPayload = {
      items,
      counts,
      total: counts.plan_pending + counts.input_needed + counts.lesson_pending + counts.mcp_trust + counts.review_ready + counts.proposal,
    }
    return reply.send(payload)
  })

  // POST /api/inbox/runs/:id/dismiss-review — stamp-once, idempotent 204.
  app.post<{ Params: { id: string } }>('/api/inbox/runs/:id/dismiss-review', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return sendError(reply, 404, 'not found')
    runsDb.markRunReviewed.run(Date.now(), req.params.id) // changes===0 = already stamped — fine
    return reply.status(204).send()
  })

  // POST /api/inbox/mcp/:id/dismiss — :id is the URL-encoded qualified_key
  // (Fastify decodes path params once; never decode again — capabilities.ts:20-21).
  app.post<{ Params: { id: string } }>('/api/inbox/mcp/:id/dismiss', async (req, reply) => {
    if (dismissMcp.run(req.params.id).changes === 0) return sendError(reply, 404, 'not found')
    return reply.status(204).send()
  })

  // E-14: approve a proposal (blocked → open, enters the E-15 auto-pull backlog).
  // changes===0 ⇒ not a live approvable proposal (unknown id, already approved/dismissed).
  app.post<{ Params: { id: string } }>('/api/inbox/proposals/:id/approve', async (req, reply) => {
    if (proposalsDb.approveProposal.run({ id: req.params.id, now: Date.now() }).changes === 0) {
      return sendError(reply, 404, 'not an open proposal')
    }
    eventBus.broadcast({ type: 'proposal_update' })
    return reply.status(204).send()
  })
  // E-14: dismiss a proposal (blocked → cancelled). Sticky by design (see
  // proposal-collectors.ts's partial-unique-index decision) — source_key is left
  // intact so the same signal is never re-proposed ("don't nag again").
  app.post<{ Params: { id: string } }>('/api/inbox/proposals/:id/dismiss', async (req, reply) => {
    if (proposalsDb.dismissProposal.run({ id: req.params.id, now: Date.now() }).changes === 0) {
      return sendError(reply, 404, 'not an open proposal')
    }
    eventBus.broadcast({ type: 'proposal_update' })
    return reply.status(204).send()
  })
}
