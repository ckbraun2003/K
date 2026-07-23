import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isKnownModel } from '@k/shared'
import { workflowDefsDb, pipelineDb, artifactsDb } from '../db.js'
import { rowToPipelineSpec, startPipelineRun } from '../pipeline-defs.js'
import { resolveGate, rewindPipelineToStage, PipelineConflictError, type PipelineRunRow } from '../pipeline-engine.js'
import type { PipelineStageRow } from '../pipeline-executor.js'
import { getPipelineRunView, listRecentPipelineRuns, pipelineRunRowToWire, broadcastPipelineUpdate } from '../pipeline-views.js'
import { listLedger } from '../pipeline-ledger.js'
import { budgetGate } from '../budget-governor.js'
import { getProject } from '../projects.js'
import { resolveDispatchScope } from '../lead-dispatch-relay.js'
import { getProfile } from '../profiles.js'
import { domainForPipelineDef } from '../domains.js'
import { REPO_ROOT, kill } from '../supervisor.js'
import { sendError, sendZodError, sendBudgetCapped } from './http-errors.js'

/**
 * Executable-pipeline HTTP surface (D-119 Lane C, wave C2) — the operator's direct entrance
 * to the engine (the SAME startPipelineRun seam K's delegate_pipeline relay funnels through)
 * plus the live-view reads the upgraded Pipelines UI (C3) renders from. Mirrors workflows.ts /
 * rewind.ts / runs.ts posture: Zod-validated bodies (400), existence 404, gate CAS 409, and
 * the shared 429 budget park (sendBudgetCapped) on the paid `run` entrance. Auth is the global
 * onRequest hook (index.ts) — no per-route guard.
 *
 * Every mutation (run / gate / rewind / cancel) broadcasts a `pipeline_update` WS delta so the
 * live DAG re-renders; the broadcast is built from getPipelineRunView (pipeline-views.ts),
 * keeping the engine writers uncoupled from the wire.
 */

// The recent pipeline-runs list is bounded — the picker needs identity, not full history.
const RUNS_LIMIT_DEFAULT = 50
const RUNS_LIMIT_MAX = 200

// The identity recorded on a gate a route resolves (the operator, via the authenticated UI) —
// mirrors K/a-risk-signal resolving the same gate programmatically with their own identity.
const GATE_RESOLVER = 'operator'

// POST /:id/run body — the operator delegation entrance. goal is required; projectId scopes the
// run to a registered project's repo (else K's own repo); model is a pipeline-wide override.
const RunBodySchema = z
  .object({
    goal: z.string().min(1).max(20_000),
    projectId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    // ui-adjustments Round 2 (Lane B): the operator's optional "Observed by" pick — an
    // AgentProfile id whose own conversation receives pipeline-update report-backs
    // (Lane C's delivery seam). Omitted → resolved server-side to the pipeline
    // definition's DOMAIN MANAGER (workflow_definitions.domain_id → domains.manager_profile_id),
    // else left null (Lane C's delivery code handles a null owner).
    orchestratorId: z.string().min(1).optional(),
  })
  .strict()

// Gate-resolve body — approve→passed / reject→failed, with an optional operator note.
const GateBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional(),
  })
  .strict()

export async function pipelinesRoutes(app: FastifyInstance) {
  // ── definitions ────────────────────────────────────────────────────────────────────────

  // GET /api/pipelines — every pipeline DEFINITION (id/name/description + whether an executable
  // `spec` exists; a legacy row lazily compiles via namedWorkflowToPipeline, hasSpec=false).
  app.get('/api/pipelines', async (_req, reply) => {
    const rows = workflowDefsDb.listWorkflowDefRows.all() as Array<Record<string, unknown>>
    return reply.send(
      rows.map(r => {
        let description: string | null = null
        // Best-effort: read the compiled spec's description; a malformed/legacy row just omits it.
        try { description = rowToPipelineSpec(r).description ?? null } catch { /* no description */ }
        return { id: String(r.id), name: String(r.name), description, hasSpec: r.spec != null }
      }),
    )
  })

  // GET /api/pipelines/runs — recent pipeline RUNS (bounded), newest first. Registered BEFORE
  // '/api/pipelines/:id' for readability (Fastify prefers the static 'runs' segment regardless).
  app.get<{ Querystring: { limit?: string } }>('/api/pipelines/runs', async (req, reply) => {
    const raw = Number(req.query.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), RUNS_LIMIT_MAX) : RUNS_LIMIT_DEFAULT
    return reply.send(listRecentPipelineRuns(limit).map(pipelineRunRowToWire))
  })

  // GET /api/pipelines/runs/:id — one run's live PipelineRunView (404 for an unknown id).
  app.get<{ Params: { id: string } }>('/api/pipelines/runs/:id', async (req, reply) => {
    const view = getPipelineRunView(req.params.id)
    if (!view) return sendError(reply, 404, 'not found')
    return reply.send(view)
  })

  // GET /api/pipelines/runs/:id/ledger — the run's append-only progress ledger (design §6.1),
  // oldest→newest by seq. 404 for an unknown run. Read-only; the Runs pane's PipelineLedgerPanel
  // renders from this and refetches live off the pipeline_update `ledgerSeq` cursor.
  app.get<{ Params: { id: string } }>('/api/pipelines/runs/:id/ledger', async (req, reply) => {
    const run = pipelineDb.getPipelineRun.get(req.params.id) as PipelineRunRow | undefined
    if (!run) return sendError(reply, 404, 'not found')
    return reply.send(listLedger(req.params.id))
  })

  // GET /api/pipelines/runs/:id/artifacts — Lane B (runs consolidation, B4): the
  // artifacts produced/edited by this pipeline run's stages, i.e. every `artifacts`
  // row whose `linked_run_id` is one of the run's stage AGENT runs (`stage.run_id`,
  // NOT the pipeline run's own id). 404 for an unknown run; an empty stage-runId
  // set (nothing dispatched yet) short-circuits to `[]` without a query.
  app.get<{ Params: { id: string } }>('/api/pipelines/runs/:id/artifacts', async (req, reply) => {
    const run = pipelineDb.getPipelineRun.get(req.params.id) as PipelineRunRow | undefined
    if (!run) return sendError(reply, 404, 'not found')
    const stages = pipelineDb.listStagesForPipeline.all(req.params.id) as PipelineStageRow[]
    const runIds = stages.map(s => s.run_id).filter((id): id is string => id != null)
    const rows = artifactsDb.listArtifactsByLinkedRunIds(runIds) as Array<Record<string, unknown>>
    return reply.send(
      rows.map(r => ({
        slug: String(r.slug),
        title: String(r.title),
        phase: r.phase ? String(r.phase) : undefined,
        status: r.status ? String(r.status) : undefined,
        tags: JSON.parse(String(r.tags ?? '[]')),
        linkedRunId: r.linked_run_id ? String(r.linked_run_id) : undefined,
        updatedAt: Number(r.updated_at),
        projectId: r.project_id == null ? null : String(r.project_id),
        origin: (r.origin as 'compiled' | 'scanned' | undefined) ?? 'compiled',
      })),
    )
  })

  // POST /api/pipelines/runs/:id/stages/:sid/gate — resolve a parked gate (single-resolver CAS).
  // Body 400 → stage 404 → 409 when already resolved. Broadcasts the refreshed view.
  app.post<{ Params: { id: string; sid: string } }>('/api/pipelines/runs/:id/stages/:sid/gate', async (req, reply) => {
    const parsed = GateBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const stage = pipelineDb.getStage.get(req.params.sid) as PipelineStageRow | undefined
    if (!stage || stage.pipeline_run_id !== req.params.id) return sendError(reply, 404, 'not found')
    const resolved = resolveGate(req.params.sid, parsed.data.decision, GATE_RESOLVER, parsed.data.note)
    if (!resolved) return sendError(reply, 409, 'gate already resolved')
    broadcastPipelineUpdate(req.params.id, req.params.sid)
    return reply.send(getPipelineRunView(req.params.id))
  })

  // POST /api/pipelines/runs/:id/stages/:sid/rewind — operator rewind/retry AT a stage: reset it
  // + every downstream stage to pending (and reopen a finalized pipeline). Stage 404. Broadcasts.
  app.post<{ Params: { id: string; sid: string } }>('/api/pipelines/runs/:id/stages/:sid/rewind', async (req, reply) => {
    const stage = pipelineDb.getStage.get(req.params.sid) as PipelineStageRow | undefined
    if (!stage || stage.pipeline_run_id !== req.params.id) return sendError(reply, 404, 'not found')
    try {
      rewindPipelineToStage(req.params.id, stage.stage_key)
    } catch (e) {
      // A conflict (pipeline/stage vanished in the TOCTOU window) maps to 404; anything else 500s.
      if (e instanceof PipelineConflictError) return sendError(reply, 404, 'not found')
      req.log.error(e)
      return sendError(reply, 500, 'rewind failed')
    }
    broadcastPipelineUpdate(req.params.id, req.params.sid)
    return reply.send(getPipelineRunView(req.params.id))
  })

  // POST /api/pipelines/runs/:id/cancel — mark the pipeline cancelled + best-effort kill any
  // in-flight stage's linked run (the existing run-kill path). 404 unknown · 409 not running.
  app.post<{ Params: { id: string } }>('/api/pipelines/runs/:id/cancel', async (req, reply) => {
    const run = pipelineDb.getPipelineRun.get(req.params.id) as PipelineRunRow | undefined
    if (!run) return sendError(reply, 404, 'not found')
    if (run.status !== 'running') return sendError(reply, 409, 'pipeline is not running')
    const stages = pipelineDb.listStagesForPipeline.all(req.params.id) as PipelineStageRow[]
    for (const s of stages) {
      if ((s.status === 'dispatched' || s.status === 'running') && s.run_id) {
        try { kill(s.run_id) } catch { /* best-effort — the run may already be gone */ }
      }
    }
    const now = Date.now()
    pipelineDb.updatePipelineStatus.run({ id: req.params.id, status: 'cancelled', updatedAt: now, completedAt: now })
    broadcastPipelineUpdate(req.params.id, null)
    return reply.send(getPipelineRunView(req.params.id))
  })

  // GET /api/pipelines/:id — one definition's compiled PipelineSpec (404 unknown · 500 on a
  // malformed spec that fails to compile).
  app.get<{ Params: { id: string } }>('/api/pipelines/:id', async (req, reply) => {
    const row = workflowDefsDb.getWorkflowDefRow.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return sendError(reply, 404, 'not found')
    try {
      return reply.send(rowToPipelineSpec(row))
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'failed to compile pipeline spec')
    }
  })

  // POST /api/pipelines/:id/run — the operator delegation entrance (in-process, no queue): resolve
  // the project scope → cwd (fail-closed), park at the budget cap (429), then startPipelineRun. The
  // scheduler picks up the running pipeline on its next tick. Body 400 → model 400 → orchestrator
  // 400 → def 404 → scope 400 → budget 429 → 201 { pipelineRunId }. `orchestratorId` ("Observed by")
  // stamps `pipeline_runs.owner_profile_id`, defaulting to the definition's domain manager.
  app.post<{ Params: { id: string } }>('/api/pipelines/:id/run', async (req, reply) => {
    const parsed = RunBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)
    const { goal, projectId, model, orchestratorId } = parsed.data
    if (model !== undefined && !isKnownModel(model)) return sendError(reply, 400, 'unknown model')
    // An explicit "Observed by" pick must name a real CHIEF- or ORCHESTRATOR-tier
    // profile (the same tiers the UI picker offers) — a stale/typo'd id would silently
    // orphan the report-back, and a secretary-tier id (K) would land the pipeline
    // update in the personal K chat, the very leak Lane C removes. Enforce the tier
    // here so intent and validation match (the domain-manager default is chief-tier).
    if (orchestratorId !== undefined) {
      const owner = getProfile(orchestratorId)
      if (!owner || (owner.tier !== 'chief' && owner.tier !== 'orchestrator')) {
        return sendError(reply, 400, 'unknown orchestrator')
      }
    }
    // Resolve the definition by id, then name (mirrors delegate_pipeline), pinning the canonical id.
    const defRow = (workflowDefsDb.getWorkflowDefRow.get(req.params.id) ??
      workflowDefsDb.getWorkflowDefByNameRow.get(req.params.id)) as { id?: string } | undefined
    if (!defRow?.id) return sendError(reply, 404, 'not found')
    // "Observed by": the operator's explicit pick wins; omitted → the definition's DOMAIN
    // MANAGER (workflow_definitions.domain_id → domains.manager_profile_id) when the def
    // belongs to a domain; else null (Lane C's delivery code tolerates a null owner).
    const ownerProfileId = orchestratorId ?? domainForPipelineDef(defRow.id)?.managerProfileId ?? null
    // Resolve the pinned project scope → cwd (SAME fail-closed check the relay uses); an unscoped
    // run executes against K's own repo (REPO_ROOT).
    let resolvedProjectId: string | null = null
    let cwd = REPO_ROOT
    if (projectId !== undefined) {
      const project = getProject(projectId)
      const scope = resolveDispatchScope([project ? project.name : projectId])
      if (scope.error || !scope.cwd) return sendError(reply, 400, scope.error ?? 'project resolved no cwd')
      resolvedProjectId = scope.projectId
      cwd = scope.cwd
    }
    // Same measured budget park as POST /api/runs (org OR scoped project at cap → 429).
    const g = budgetGate({ projectId: resolvedProjectId })
    if (!g.allowed) return sendBudgetCapped(reply, g)
    try {
      const { pipelineRunId } = await startPipelineRun(defRow.id, { goal, projectId: resolvedProjectId, cwd, model, ownerProfileId })
      broadcastPipelineUpdate(pipelineRunId, null)
      return reply.status(201).send({ pipelineRunId })
    } catch (e) {
      req.log.error(e)
      return sendError(reply, 500, 'pipeline dispatch failed')
    }
  })
}
