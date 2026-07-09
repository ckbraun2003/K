/**
 * P2 A2 — plan route contracts + planGate dispatch resolution. The supervisor is
 * mocked (echo startRun + result-shaped plan-gate fakes): route mapping only.
 * NOTE: hoisted factory — no outer bindings inside it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, runPlansDb, agentProfilesDb } from '../src/db.js'
import { ORG_DEFAULT_PROFILE_ID } from '../src/plan-gate.js'
import { seedProfiles } from '../src/profiles.js'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return {
    ...actual,
    startRun: vi.fn(async (prompt: string, opts: Record<string, unknown>) => ({
      id: 'mock-run', prompt, cwd: String(opts.cwd ?? 'C:\\mock'), status: 'queued', provider: 'claude',
      model: 'mock', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now(),
      __opts: opts, // echoed so the test can assert planGate resolution
    })),
    kill: vi.fn(() => false),
    approvePlanRun: vi.fn(async (id: string) =>
      id === 'gone-run' ? { ok: false, code: 410, error: 'parked plan state is gone — re-dispatch the run' }
      : id === 'raced-run' ? { ok: false, code: 409, error: 'plan already approved' }
      : { ok: true, run: { id, prompt: 'p', cwd: 'C:\\m', status: 'running', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1 } }),
    discardPlanRun: vi.fn(async (id: string) =>
      id === 'not-parked' ? { ok: false, code: 409, error: 'run is not awaiting plan approval' }
      : { ok: true, run: { id, prompt: 'p', cwd: 'C:\\m', status: 'killed', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 1 } }),
  }
})

import { startRun } from '../src/supervisor.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
const runIds: string[] = []

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})
afterAll(async () => {
  for (const id of runIds) {
    try { db.prepare('DELETE FROM run_plans WHERE run_id = ?').run(id) } catch { /* */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* */ }
  }
  await app.close()
})

function seedParked(plan: string | null): string {
  const id = randomUUID()
  runIds.push(id)
  runsDb.insertRun.run({ id, prompt: 'gated', cwd: 'C:\\nowhere', worktree: null, status: 'awaiting_plan',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now() })
  runPlansDb.insertRunPlan.run({ runId: id, plan, raw: 'raw text', edited: 0, profileId: null, createdAt: 1, updatedAt: 1 })
  return id
}

const DOC = JSON.stringify({ steps: [{ title: 'a' }], files: ['f.ts'], risk: 'low' })

describe('plan routes', () => {
  it('GET returns the wire RunPlan (parsed + degraded); 404s cleanly', async () => {
    const id = seedParked(DOC)
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}/plan`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: id, edited: false, plan: { risk: 'low' }, raw: 'raw text' })
    const degraded = seedParked(null)
    expect((await app.inject({ method: 'GET', url: `/api/runs/${degraded}/plan`, headers: AUTH })).json().plan).toBeNull()
    expect((await app.inject({ method: 'GET', url: `/api/runs/${randomUUID()}/plan`, headers: AUTH })).statusCode).toBe(404)
  })

  it('PATCH edits last-wins (edited flips true), 400 strict body, 409 when not parked', async () => {
    const id = seedParked(DOC)
    const good = await app.inject({ method: 'PATCH', url: `/api/runs/${id}/plan`, headers: JSON_HEADERS,
      payload: JSON.stringify({ plan: { steps: [{ title: 'edited step' }], files: [], risk: 'high' } }) })
    expect(good.statusCode).toBe(200)
    expect(good.json()).toMatchObject({ edited: true, plan: { risk: 'high' } })
    expect((await app.inject({ method: 'PATCH', url: `/api/runs/${id}/plan`, headers: JSON_HEADERS,
      payload: JSON.stringify({ nope: 1 }) })).statusCode).toBe(400)
    db.prepare(`UPDATE runs SET status = 'done' WHERE id = ?`).run(id)
    expect((await app.inject({ method: 'PATCH', url: `/api/runs/${id}/plan`, headers: JSON_HEADERS,
      payload: JSON.stringify({ plan: { steps: [{ title: 'x' }], files: [], risk: 'low' } }) })).statusCode).toBe(409)
  })

  it('approve/discard map PlanGateActionResult codes 1:1 (200/409/410)', async () => {
    const ok = seedParked(DOC)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${ok}/approve-plan`, headers: AUTH })).statusCode).toBe(200)
    runIds.push('gone-run', 'raced-run', 'not-parked')
    runsDb.insertRun.run({ id: 'gone-run', prompt: 'x', cwd: 'C:\\n', worktree: null, status: 'awaiting_plan',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: 1 })
    expect((await app.inject({ method: 'POST', url: `/api/runs/gone-run/approve-plan`, headers: AUTH })).statusCode).toBe(410)
    runsDb.insertRun.run({ id: 'raced-run', prompt: 'x', cwd: 'C:\\n', worktree: null, status: 'awaiting_plan',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: 1 })
    expect((await app.inject({ method: 'POST', url: `/api/runs/raced-run/approve-plan`, headers: AUTH })).statusCode).toBe(409)
    runsDb.insertRun.run({ id: 'not-parked', prompt: 'x', cwd: 'C:\\n', worktree: null, status: 'done',
      provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: 1 })
    expect((await app.inject({ method: 'POST', url: `/api/runs/not-parked/discard-plan`, headers: AUTH })).statusCode).toBe(409)
  })
})

describe('POST /api/runs planGate resolution (D-084)', () => {
  const before = agentProfilesDb.getProfileRow.get(ORG_DEFAULT_PROFILE_ID) as { plan_gate?: number } | undefined
  afterAll(() => { if (before) agentProfilesDb.setProfilePlanGate.run(before.plan_gate ?? 0, ORG_DEFAULT_PROFILE_ID) })

  async function dispatch(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: JSON_HEADERS,
      payload: JSON.stringify({ prompt: 'x', ...body }) })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(startRun).mock.calls.at(-1)!
    return call[1] as Record<string, unknown>
  }

  it('explicit toggle wins; absent falls back to the org-default tier flag', async () => {
    if (before) agentProfilesDb.setProfilePlanGate.run(0, ORG_DEFAULT_PROFILE_ID)
    expect((await dispatch({ planGate: true })).planGate).toBe(true)
    expect((await dispatch({})).planGate).toBe(false)
    if (before) {
      agentProfilesDb.setProfilePlanGate.run(1, ORG_DEFAULT_PROFILE_ID)
      expect((await dispatch({})).planGate).toBe(true)
      expect((await dispatch({ planGate: false })).planGate).toBe(false)
    }
  })
})

// Review fix (quality-review BLOCKER): the PATCH /api/org-default plan-gate write
// must be ATOMIC with the authority guard — a patch that updateProfile REJECTS
// (GrantError → 400) must NOT flip the org-wide plan-gate default. plan_gate is a
// HITL safety control; silently toggling it on a request the API reports as failed
// is a real safety regression. seedProfiles is idempotent (skips existing rows), so
// this guarantees the default-orchestrator row exists without clobbering it.
describe('PATCH /api/org-default plan-gate atomicity (E-02 review fix)', () => {
  beforeAll(() => { seedProfiles() })
  afterAll(() => { agentProfilesDb.setProfilePlanGate.run(0, ORG_DEFAULT_PROFILE_ID) })

  it('a rejected patch (ungranted MCP mount) does NOT flip the plan-gate default', async () => {
    agentProfilesDb.setProfilePlanGate.run(0, ORG_DEFAULT_PROFILE_ID) // baseline OFF
    const res = await app.inject({
      method: 'PATCH', url: '/api/org-default', headers: JSON_HEADERS,
      payload: JSON.stringify({ planGate: true, mcpServers: ['some-ungranted-server'] }),
    })
    expect(res.statusCode).toBe(400) // updateProfile's grant guard rejected it
    // The org-wide plan-gate default must remain OFF despite the (partial) request.
    expect((agentProfilesDb.getProfileRow.get(ORG_DEFAULT_PROFILE_ID) as { plan_gate?: number }).plan_gate).toBe(0)
  })

  it('an accepted plan-gate-only patch flips it ON and reflects it on the payload', async () => {
    agentProfilesDb.setProfilePlanGate.run(0, ORG_DEFAULT_PROFILE_ID)
    const res = await app.inject({
      method: 'PATCH', url: '/api/org-default', headers: JSON_HEADERS,
      payload: JSON.stringify({ planGate: true }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().planGate).toBe(true)
    expect((agentProfilesDb.getProfileRow.get(ORG_DEFAULT_PROFILE_ID) as { plan_gate?: number }).plan_gate).toBe(1)
  })
})
