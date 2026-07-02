import type { FastifyInstance } from 'fastify'
import path from 'path'
import { StartRunBodySchema, RunsQuerySchema, SendInputBodySchema, isKnownModel } from '@k/shared'
import { startRun, kill, sendInput, endSession, REPO_ROOT } from '../supervisor.js'
import { runsDb, eventsDb, projectsDb, workflowStepsDb } from '../db.js'
import { matchProjectByCwd, type ProjectPathRow } from '../project-match.js'

/**
 * A client-supplied `cwd` must resolve under a registered project's localPath
 * OR under the harness REPO_ROOT (its default). Anything else (e.g. C:\Windows,
 * /etc) is rejected so a run can't be launched against an arbitrary directory.
 */
function isCwdAllowed(cwd: string): boolean {
  const projects = projectsDb.listProjects.all() as ProjectPathRow[]
  // Treat REPO_ROOT as a synthetic registered root so the default cwd is allowed.
  const roots: ProjectPathRow[] = [...projects, { id: '__repo__', local_path: REPO_ROOT }]
  return matchProjectByCwd(path.resolve(cwd), roots) !== null
}

export async function runsRoutes(app: FastifyInstance) {
  // POST /api/runs — start a new agent run
  app.post('/api/runs', async (req, reply) => {
    const parsed = StartRunBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { prompt, cwd, model, projectId, preferLocal, interactive } = parsed.data
    // Validate the model at the boundary (lessons.md): reject anything not in the
    // known registry so a typo can't silently fall through to the CLI/router.
    if (model !== undefined && !isKnownModel(model)) {
      return reply.status(400).send({ error: 'unknown model' })
    }
    // A project can now be deleted (DELETE /api/projects/:id). This existence
    // check is the fast/clear path; the FK INSERT inside startRun is the source of
    // truth. If the project is removed in the TOCTOU window between the two,
    // SQLite raises a FOREIGN KEY error — caught below and mapped to 400, not 500.
    if (projectId && !projectsDb.getProject.get(projectId)) {
      return reply.status(400).send({ error: 'unknown projectId' })
    }
    if (cwd !== undefined && !isCwdAllowed(cwd)) {
      return reply.status(400).send({ error: 'cwd not under a registered project' })
    }
    try {
      const run = await startRun(prompt, { cwd, model, projectId, preferLocal, interactive })
      return reply.status(201).send(run)
    } catch (e) {
      // The only FK on the runs INSERT is project_id → projects(id), so a SQLite
      // "FOREIGN KEY constraint failed" here means the project was deleted in the
      // TOCTOU window — a client 400, not a 500. (Revisit this mapping if runs ever
      // gains another foreign key.)
      const msg = e instanceof Error ? e.message : String(e)
      if (/FOREIGN KEY/i.test(msg)) return reply.status(400).send({ error: 'unknown projectId' })
      req.log.error(e)
      return reply.status(500).send({ error: 'run failed' })
    }
  })

  // GET /api/runs — list recent runs; optional ?status=, ?limit=, ?projectId= query params
  app.get('/api/runs', async (req, reply) => {
    const parsed = RunsQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    // projectId filter: if provided, validate that the project exists
    if (parsed.data.projectId && !projectsDb.getProject.get(parsed.data.projectId)) {
      return reply.status(400).send({ error: 'unknown projectId' })
    }
    const rows = runsDb.listRunsFiltered(parsed.data)
    return reply.send(rows.map(dbRowToRun))
  })

  // GET /api/runs/:id — single run
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const row = runsDb.getRun.get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return reply.status(404).send({ error: 'not found' })
    return reply.send(dbRowToRun(row))
  })

  // GET /api/runs/:id/events — event log for a run
  // ?raw=1 opts into including the original JSON line in each event.
  // Only the literal '1' enables it; ?raw=true / bare ?raw are intentionally off.
  app.get<{ Params: { id: string }; Querystring: { raw?: string } }>('/api/runs/:id/events', async (req, reply) => {
    const rows = eventsDb.listEvents.all(req.params.id) as Array<Record<string, unknown>>
    const includeRaw = req.query.raw === '1'
    return reply.send(rows.map(r => dbRowToEvent(r, includeRaw)))
  })

  // GET /api/runs/:id/events/:seq/raw — lazy single-event raw fetch.
  // Returns { raw: string } for the one event identified by run_id + seq.
  // 404 if the event doesn't exist OR if it exists but has no stored raw (null).
  app.get<{ Params: { id: string; seq: string } }>('/api/runs/:id/events/:seq/raw', async (req, reply) => {
    const seq = Number(req.params.seq)
    // reject non-numeric seq before it binds as NaN→0 and silently queries the wrong row
    if (!Number.isInteger(seq) || seq < 0) return reply.status(400).send({ error: 'seq must be a non-negative integer' })
    const row = eventsDb.getEventRaw.get(req.params.id, seq) as { raw: string | null } | undefined
    if (!row || row.raw == null) return reply.status(404).send({ error: 'not found' })
    return reply.send({ raw: row.raw })
  })

  // GET /api/runs/:id/workflow-steps — the explicit progress checklist the
  // orchestrator reports through the kstore status-write tools, resolved via the
  // run's workflow_run. Returns { workflowRun: null, steps: [] } when the run is
  // not a delegation workflow (so the UI can cleanly omit the panel).
  app.get<{ Params: { id: string } }>('/api/runs/:id/workflow-steps', async (req, reply) => {
    const wf = workflowStepsDb.getWorkflowRunByRunId.get(req.params.id) as
      | Record<string, unknown>
      | undefined
    if (!wf) return reply.send({ workflowRun: null, steps: [] })
    const steps = workflowStepsDb.listWorkflowSteps.all(wf.id) as Array<Record<string, unknown>>
    return reply.send({ workflowRun: dbRowToWorkflowRun(wf), steps: steps.map(dbRowToWorkflowStep) })
  })

  // POST /api/runs/:id/kill — kill a running agent
  app.post<{ Params: { id: string } }>('/api/runs/:id/kill', async (req, reply) => {
    const killed = kill(req.params.id)
    return reply.send({ killed })
  })

  // POST /api/runs/:id/input — feed the operator's next turn into an interactive
  // run parked at awaiting_input. 404 unknown run · 400 bad body · 409 not awaiting · 204 ok.
  app.post<{ Params: { id: string } }>('/api/runs/:id/input', async (req, reply) => {
    const parsed = SendInputBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
    if (!runsDb.getRun.get(req.params.id)) return reply.status(404).send({ error: 'not found' })
    // sendInput returns false when the run has no live interactive process or isn't
    // awaiting input — a stale client trying to answer a finished/mid-turn run.
    if (!sendInput(req.params.id, parsed.data.text)) {
      return reply.status(409).send({ error: 'run is not awaiting input' })
    }
    return reply.status(204).send()
  })

  // POST /api/runs/:id/end — gracefully end an interactive session (close stdin →
  // agent finishes → status 'done'). 404 unknown · 200 { ended } (false if not interactive).
  app.post<{ Params: { id: string } }>('/api/runs/:id/end', async (req, reply) => {
    if (!runsDb.getRun.get(req.params.id)) return reply.status(404).send({ error: 'not found' })
    return reply.send({ ended: endSession(req.params.id) })
  })
}

function dbRowToRun(r: Record<string, unknown>) {
  return {
    id: r.id, prompt: r.prompt, cwd: r.cwd, worktree: r.worktree,
    status: r.status, provider: r.provider, model: r.model,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    projectId: r.project_id ?? undefined,
    createdAt: r.created_at, endedAt: r.ended_at,
  }
}

/** Parse a JSON DB column defensively: null/undefined → undefined; malformed →
 *  undefined (a single corrupt row must not 500 the whole event list). */
function safeJsonColumn(v: unknown): unknown {
  if (v == null) return undefined
  try { return JSON.parse(v as string) } catch { return undefined }
}

/** workflow_runs row → WorkflowRun shape (snake→camel; task_ids JSON → array,
 *  parsed defensively). Exported so routes/workflows.ts's runs list reuses this ONE
 *  mapping authority instead of mirroring it. */
export function dbRowToWorkflowRun(r: Record<string, unknown>) {
  return {
    id: r.id, projectId: r.project_id, runId: r.run_id ?? null,
    taskIds: safeJsonColumn(r.task_ids) ?? [], mode: r.mode, status: r.status,
    createdAt: r.created_at, completedAt: r.completed_at ?? null,
  }
}

/** workflow_steps row → WorkflowStep shape (snake→camel; nullable cols → null). */
function dbRowToWorkflowStep(r: Record<string, unknown>) {
  return {
    id: r.id, workflowRunId: r.workflow_run_id, seq: r.seq, label: r.label, kind: r.kind,
    workItemId: r.work_item_id ?? null, status: r.status,
    detail: r.detail ?? null, updatedAt: r.updated_at,
  }
}

function dbRowToEvent(r: Record<string, unknown>, includeRaw = false) {
  return {
    id: r.id, runId: r.run_id, seq: r.seq, type: r.type, ts: r.ts,
    text: r.text, tool: r.tool,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    // Enriched tool metadata (Wave D3). JSON columns are parsed back to objects;
    // only include keys when present to avoid a flood of undefineds on the wire.
    ...(r.tool_use_id != null ? { toolUseId: r.tool_use_id as string } : {}),
    ...(r.tool_kind != null ? { toolKind: r.tool_kind as string } : {}),
    ...(r.tool_input != null ? { toolInput: safeJsonColumn(r.tool_input) } : {}),
    ...(r.tool_result != null ? { toolResult: safeJsonColumn(r.tool_result) } : {}),
    ...(r.tool_result_is_error != null ? { toolResultIsError: r.tool_result_is_error === 1 } : {}),
    ...(r.subagent_type != null ? { subagentType: r.subagent_type as string } : {}),
    ...(r.child_label != null ? { childLabel: r.child_label as string } : {}),
    // context_tokens (Wave D6): a plain number — no JSON parse needed.
    ...(r.context_tokens != null ? { contextTokens: r.context_tokens as number } : {}),
    ...(includeRaw && r.raw != null ? { raw: r.raw as string } : {}),
  }
}
