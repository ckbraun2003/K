/**
 * D-119 Lane C / wave C2 — /api/pipelines HTTP surface + pipeline_update WS (TOKEN-FREE).
 *
 * The real fastify app (buildApp), the shared vitest SQLite DB (unique UUIDs per test), a real
 * throwaway git repo for the operator run entrance. NO `claude` ever spawns: the app's pipeline
 * SCHEDULER is not started by buildApp (it lives in the separate boot fn), so POST /run only
 * INSTANTIATES the ledger — nothing dispatches. Proves:
 *   - definition list/detail (compiled PipelineSpec);
 *   - run → view roundtrip (POST /run → GET /runs/:id validates against PipelineRunViewSchema);
 *   - getPipelineRunView schema-validates + resolves a stage's linked-run cost;
 *   - gate resolve happy path (200) + already-resolved 409 + unknown-stage 404;
 *   - rewind resets the target + downstream to pending and reopens a finalized pipeline;
 *   - cancel marks the pipeline cancelled (+ 409 when not running, 404 unknown);
 *   - the budget cap parks POST /run with the shared 429 envelope;
 *   - a pipeline_update broadcast fires on a transition (eventBus.broadcast spy).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db, pipelineDb, workflowDefsDb } from '../src/db.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { budgetStatus } from '../src/budget-governor.js'
import { getPipelineRunView } from '../src/pipeline-views.js'
import { eventBus } from '../src/events.js'
import { PipelineRunViewSchema, type WsMessage } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let repo: string
let baseCommit: string
let projectId: string
const DEF_ID = `pl-c2-${randomUUID().slice(0, 8)}`
const createdPipelineRunIds: string[] = []
const spentRunIds: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// A minimal, VALID, executable PipelineSpec (all deterministic — the scheduler is not started by
// buildApp, so nothing dispatches regardless; this is instantiation-only).
const SPEC = {
  name: 'C2 test pipeline',
  description: 'route-test pipeline',
  stages: [
    { kind: 'deterministic', id: 'build', label: 'build', action: { type: 'command', run: 'node -e "0"' } },
    { kind: 'deterministic', id: 'test', label: 'test', action: { type: 'command', run: 'node -e "0"' } },
  ],
  edges: [
    { from: 'build', to: 'test', handoff: 'share-tree' },
    { from: 'test', to: 'done', handoff: 'share-tree' },
  ],
  entry: 'build',
}

/** Seed a pipeline ledger directly (unique ids); returns the run id + a stage-key→id map. */
function seedPipeline(
  status: 'running' | 'failed' | 'completed',
  stages: Array<{ key: string; kind: string; status: 'pending' | 'awaiting_gate' | 'passed' | 'failed'; runId?: string }>,
  edges: Array<{ from: string | null; to: string }>,
): { plr: string; ids: Record<string, string> } {
  const plr = randomUUID()
  createdPipelineRunIds.push(plr)
  const now = Date.now()
  pipelineDb.insertPipelineRun.run({
    id: plr, definitionId: null, projectId: null, title: 't', cwd: repo, baseCommit, createdAt: now, updatedAt: now,
  })
  if (status !== 'running') pipelineDb.updatePipelineStatus.run({ id: plr, status, updatedAt: now, completedAt: now })
  const ids: Record<string, string> = {}
  for (const s of stages) {
    const id = randomUUID()
    ids[s.key] = id
    pipelineDb.insertStage.run({
      id, pipelineRunId: plr, stageKey: s.key, kind: s.kind, profileId: null, spec: '{}',
      baseCommit: null, repairStageKey: null, createdAt: now, updatedAt: now,
    })
    if (s.runId) pipelineDb.setStageRun.run({ id, runId: s.runId, baseCommit, updatedAt: now }) // → running, run_id set
    if (s.status === 'awaiting_gate') pipelineDb.markStageAwaitingGate.run({ id, updatedAt: now })
    else if (s.status === 'passed') pipelineDb.markStagePassed.run({ id, resultCommit: baseCommit, exitCode: 0, costUsd: null, updatedAt: now, completedAt: now })
    else if (s.status === 'failed') pipelineDb.markStageFailed.run({ id, failureClass: null, exitCode: 1, costUsd: null, updatedAt: now, completedAt: now })
  }
  for (const e of edges) {
    pipelineDb.insertEdge.run({ id: randomUUID(), pipelineRunId: plr, fromStageKey: e.from, toStageKey: e.to, handoff: 'share-tree', whenCond: 'always' })
  }
  return { plr, ids }
}

beforeAll(async () => {
  app = await (await import('../src/index.js')).buildApp()
  await app.ready()

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'k-pl-c2-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@t.local'])
  git(repo, ['config', 'user.name', 't'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

  projectId = randomUUID()
  db.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
    .run(projectId, `pl-c2-${projectId.slice(0, 8)}`, repo, Date.now())

  // Seed one executable pipeline DEFINITION (a workflow_definitions row + its JSON spec).
  workflowDefsDb.insertWorkflowDef.run({
    id: DEF_ID, name: `C2 Def ${DEF_ID}`, roles: '[]', promptScaffold: 'x', crossProject: 0, createdAt: Date.now(),
  })
  pipelineDb.setDefSpec.run({ id: DEF_ID, spec: JSON.stringify(SPEC) })
}, 60_000)

afterAll(async () => {
  setAutonomySettings({ orgDailyBudgetUsd: null }); __resetConfigCache()
  await app.close()
  for (const id of createdPipelineRunIds) {
    db.prepare('DELETE FROM pipeline_edges WHERE pipeline_run_id = ?').run(id)
    db.prepare('DELETE FROM pipeline_stages WHERE pipeline_run_id = ?').run(id)
    db.prepare('DELETE FROM pipeline_runs WHERE id = ?').run(id)
  }
  for (const id of spentRunIds) db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(DEF_ID)
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

describe('pipeline definitions', () => {
  it('GET /pipelines lists definitions; GET /pipelines/:id compiles the spec; 404 unknown', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/pipelines', headers: AUTH })
    expect(list.statusCode).toBe(200)
    const mine = (list.json() as Array<{ id: string; hasSpec: boolean; description: string | null }>).find(d => d.id === DEF_ID)
    expect(mine).toMatchObject({ id: DEF_ID, hasSpec: true, description: 'route-test pipeline' })

    const detail = await app.inject({ method: 'GET', url: `/api/pipelines/${DEF_ID}`, headers: AUTH })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ name: 'C2 test pipeline', entry: 'build' })

    expect((await app.inject({ method: 'GET', url: `/api/pipelines/${randomUUID()}`, headers: AUTH })).statusCode).toBe(404)
  })
})

describe('POST /pipelines/:id/run → view roundtrip', () => {
  it('creates a pipeline and GET /runs/:id returns a schema-valid view; runs list includes it', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/pipelines/${DEF_ID}/run`, headers: JSON_HEADERS,
      payload: JSON.stringify({ goal: 'do the thing', projectId }),
    })
    expect(res.statusCode).toBe(201)
    const pipelineRunId = res.json().pipelineRunId as string
    expect(typeof pipelineRunId).toBe('string')
    createdPipelineRunIds.push(pipelineRunId)

    const viewRes = await app.inject({ method: 'GET', url: `/api/pipelines/runs/${pipelineRunId}`, headers: AUTH })
    expect(viewRes.statusCode).toBe(200)
    expect(PipelineRunViewSchema.safeParse(viewRes.json()).success).toBe(true)
    expect(viewRes.json().run.id).toBe(pipelineRunId)
    expect((viewRes.json().stages as Array<{ stageKey: string }>).map(s => s.stageKey).sort()).toEqual(['build', 'test'])

    const runsRes = await app.inject({ method: 'GET', url: '/api/pipelines/runs?limit=100', headers: AUTH })
    expect(runsRes.statusCode).toBe(200)
    expect((runsRes.json() as Array<{ id: string }>).some(r => r.id === pipelineRunId)).toBe(true)

    expect((await app.inject({ method: 'GET', url: `/api/pipelines/runs/${randomUUID()}`, headers: AUTH })).statusCode).toBe(404)
  })

  it('parks with the shared 429 budget envelope when the org cap is reached', async () => {
    // A measured run pushes org spend above a low cap → capped (classifyBudget: spent >= cap).
    const runId = `pl-c2-spend-${randomUUID().slice(0, 8)}`
    spentRunIds.push(runId)
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, cost_usd, created_at) VALUES (?, 'x', '.', 'done', 5, ?)`).run(runId, Date.now())
    setAutonomySettings({ orgDailyBudgetUsd: 0.01 }); __resetConfigCache()
    expect(budgetStatus().org.state).toBe('capped')

    const res = await app.inject({
      method: 'POST', url: `/api/pipelines/${DEF_ID}/run`, headers: JSON_HEADERS,
      payload: JSON.stringify({ goal: 'g' }),
    })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'org budget cap reached', scope: 'org' })
    expect(typeof res.json().capUsd).toBe('number')

    setAutonomySettings({ orgDailyBudgetUsd: null }); __resetConfigCache()
  })
})

describe('getPipelineRunView', () => {
  it('assembles a schema-valid view (resolving the linked-run cost) and returns null for an unknown id', () => {
    const runId = `pl-c2-cost-${randomUUID().slice(0, 8)}`
    spentRunIds.push(runId)
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, cost_usd, created_at) VALUES (?, 'x', ?, 'done', 0.42, ?)`).run(runId, repo, Date.now())

    const { plr } = seedPipeline('running',
      [{ key: 'impl', kind: 'agent', status: 'pending', runId }, { key: 'review', kind: 'agent', status: 'pending' }],
      [{ from: 'impl', to: 'review' }, { from: 'review', to: 'done' }])

    const view = getPipelineRunView(plr)
    expect(view).not.toBeNull()
    expect(PipelineRunViewSchema.safeParse(view).success).toBe(true)
    const impl = view!.stages.find(s => s.stageKey === 'impl')!
    expect(impl.runId).toBe(runId)
    expect(impl.costUsd).toBe(0.42) // resolved from the linked run's cost_usd
    expect(impl.canonical).toBeDefined()

    expect(getPipelineRunView(randomUUID())).toBeNull()
  })
})

describe('gate resolve', () => {
  it('approves (200), 409s the already-resolved gate, 404s an unknown stage', async () => {
    const { plr, ids } = seedPipeline('running',
      [{ key: 'g', kind: 'gate', status: 'awaiting_gate' }, { key: 'next', kind: 'deterministic', status: 'pending' }],
      [{ from: 'g', to: 'next' }])

    const ok = await app.inject({
      method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${ids.g}/gate`, headers: JSON_HEADERS,
      payload: JSON.stringify({ decision: 'approve', note: 'lgtm' }),
    })
    expect(ok.statusCode).toBe(200)
    expect(PipelineRunViewSchema.safeParse(ok.json()).success).toBe(true)
    expect((pipelineDb.getStage.get(ids.g) as { status: string }).status).toBe('passed')
    expect((pipelineDb.getStage.get(ids.g) as { gate_note: string | null }).gate_note).toBe('lgtm')

    const dup = await app.inject({
      method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${ids.g}/gate`, headers: JSON_HEADERS,
      payload: JSON.stringify({ decision: 'approve' }),
    })
    expect(dup.statusCode).toBe(409)

    const missing = await app.inject({
      method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${randomUUID()}/gate`, headers: JSON_HEADERS,
      payload: JSON.stringify({ decision: 'approve' }),
    })
    expect(missing.statusCode).toBe(404)

    // a bad body (unknown decision) is a 400
    const bad = await app.inject({
      method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${ids.g}/gate`, headers: JSON_HEADERS,
      payload: JSON.stringify({ decision: 'maybe' }),
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('rewind', () => {
  it('resets the target + downstream to pending and reopens a finalized pipeline', async () => {
    const { plr, ids } = seedPipeline('failed',
      [{ key: 'a', kind: 'deterministic', status: 'passed' },
       { key: 'b', kind: 'deterministic', status: 'passed' },
       { key: 'c', kind: 'deterministic', status: 'failed' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])

    const res = await app.inject({ method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${ids.b}/rewind`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(PipelineRunViewSchema.safeParse(res.json()).success).toBe(true)

    expect((pipelineDb.getStage.get(ids.a) as { status: string }).status).toBe('passed')  // upstream untouched
    expect((pipelineDb.getStage.get(ids.b) as { status: string }).status).toBe('pending') // target reset
    expect((pipelineDb.getStage.get(ids.c) as { status: string }).status).toBe('pending') // downstream reset
    expect((pipelineDb.getStage.get(ids.c) as { failure_class: string | null }).failure_class).toBeNull()
    expect((pipelineDb.getPipelineRun.get(plr) as { status: string }).status).toBe('running') // reopened

    expect((await app.inject({ method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${randomUUID()}/rewind`, headers: AUTH })).statusCode).toBe(404)
  })
})

describe('cancel', () => {
  it('marks the pipeline cancelled; 409 when not running; 404 unknown', async () => {
    const { plr } = seedPipeline('running',
      [{ key: 'a', kind: 'deterministic', status: 'pending' }], [{ from: 'a', to: 'done' }])

    const res = await app.inject({ method: 'POST', url: `/api/pipelines/runs/${plr}/cancel`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect((pipelineDb.getPipelineRun.get(plr) as { status: string }).status).toBe('cancelled')

    const dup = await app.inject({ method: 'POST', url: `/api/pipelines/runs/${plr}/cancel`, headers: AUTH })
    expect(dup.statusCode).toBe(409)

    expect((await app.inject({ method: 'POST', url: `/api/pipelines/runs/${randomUUID()}/cancel`, headers: AUTH })).statusCode).toBe(404)
  })
})

describe('pipeline_update broadcast', () => {
  it('fires a pipeline_update carrying the transitioned stage id on a gate resolve', async () => {
    const { plr, ids } = seedPipeline('running',
      [{ key: 'g', kind: 'gate', status: 'awaiting_gate' }], [{ from: 'g', to: 'done' }])

    const spy = vi.spyOn(eventBus, 'broadcast')
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/pipelines/runs/${plr}/stages/${ids.g}/gate`, headers: JSON_HEADERS,
        payload: JSON.stringify({ decision: 'reject' }),
      })
      expect(res.statusCode).toBe(200)
      const hit = spy.mock.calls
        .map(c => c[0] as WsMessage)
        .find((m): m is Extract<WsMessage, { type: 'pipeline_update' }> => m.type === 'pipeline_update' && m.pipelineRunId === plr)
      expect(hit).toBeTruthy()
      expect(hit!.stageId).toBe(ids.g)
      expect(hit!.view.run.id).toBe(plr)
    } finally {
      spy.mockRestore()
    }
  })
})
