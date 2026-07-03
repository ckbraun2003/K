/**
 * C2b — lead-dispatch "active intent" LIVENESS DERIVATION (conductor blocker fix).
 *
 * lead_dispatches has NO success-terminal status (CHECK pending|dispatched|failed) and
 * the relay deliberately leaves a completed intent 'dispatched' forever. Before this fix,
 * getActiveLeadDispatchByAssignment counted every 'dispatched' row as active — so ONE
 * successful dispatch permanently wedged its assignment: dispatch_lead guard 2 and the
 * reassign route's guard 2 both 409'd forever, and dispatch_lead guard 1 (bare
 * lead_run_id != null) blocked follow-ups even after the run completed.
 *
 * Now "active" is DERIVED from the linked run's liveness (LEFT JOIN runs; see db.ts).
 * These tests pin BOTH directions:
 *   (1) end-to-end: dispatch → drain → terminal → REASSIGN 200 → dispatch NEW lead → drain;
 *   (2) the latent pre-C2 wedge: a completed assignment (no reassign) accepts a follow-up
 *       dispatch_lead;
 *   (3) still-blocking pins: a pending intent blocks; a dispatched intent with a LIVE run
 *       blocks; a dispatched intent with lead_run_id NULL (claim-window orphan) blocks.
 *
 * Harness: buildApp (the reassign PATCH rides the real route + bearer hook, mirroring
 * chief-route.test.ts) + the chief-dispatch.test.ts supervisor mock (startRun inserts a
 * real 'running' runs row — agent_runs.run_id and mgmt_assignments.lead_run_id FK →
 * runs(id)). The relay's pending-only CAS claim is untouched by the statement change:
 * drains here execute exactly one intent per pending row, asserted via the recorded ids.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import type { Assignment } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-c2b-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'c2b', '.', 'running', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Imported AFTER the mock so the transitive supervisor import is mocked.
const { db, mgmtDb, leadDispatchDb } = await import('../src/db.js')
const { seedProfiles } = await import('../src/profiles.js')
const { seedWorkflowDefinitions } = await import('../src/workflow-defs.js')
const { mgmtTools, MgmtError } = await import('../src/mcp/mgmt.js')
const { drainLeadDispatches } = await import('../src/lead-dispatch-relay.js')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const CHIEF_RUN = uuid() // the delegation parent (a real runs row; owns the assignments)
const ctxChief = { runId: CHIEF_RUN }

let app: FastifyInstance

/** Invoke a mgmt tool through the registry (as the server would). */
function call(name: string, args: unknown, ctx: { runId: string | null }): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

function insertRunRow(id: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'c2b', '.', ?, ?)`,
  ).run(id, status, Date.now())
}

function setRunStatus(id: string, status: string): void {
  db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, id)
}

function leadRunIdFor(assignmentId: string): string | null {
  const a = mgmtDb.getAssignment.get(assignmentId) as Record<string, unknown>
  return a.lead_run_id == null ? null : String(a.lead_run_id)
}

/** Manually craft a lead_dispatches row in a given state (the insert statement always
 *  writes 'pending'/NULL; the raw UPDATE mirrors what the relay's claim/record do). */
function insertIntent(assignmentId: string, state: { status: 'pending' | 'dispatched'; leadRunId?: string | null }): string {
  const id = uuid()
  leadDispatchDb.insertLeadDispatch.run({
    id, assignmentId, chiefRunId: CHIEF_RUN, leadProfileId: 'lead-backend',
    lead: 'Backend', workflowId: 'code-wave', goal: 'crafted intent', createdAt: Date.now(),
  })
  if (state.status === 'dispatched') {
    db.prepare(`UPDATE lead_dispatches SET status = 'dispatched', dispatched_at = ?, lead_run_id = ? WHERE id = ?`)
      .run(Date.now(), state.leadRunId ?? null, id)
  }
  return id
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  seedProfiles()
  seedWorkflowDefinitions()
  insertRunRow(CHIEF_RUN)
})

afterAll(async () => {
  // FK-safe order; audit reports from reassigns carry run_id NULL but link the assignment.
  db.prepare(`DELETE FROM mgmt_reports WHERE assignment_id IN (SELECT id FROM mgmt_assignments WHERE run_id = ?)`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM lead_dispatches WHERE chief_run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-c2b-run-%'`).run()
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-c2b-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-c2b-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(CHIEF_RUN)
  await app.close()
})

describe('lead-dispatch liveness derivation (C2b blocker fix)', () => {
  it('(2) a COMPLETED dispatch does not wedge the assignment — a follow-up dispatch_lead succeeds', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'first wave' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const firstRun = leadRunIdFor(assigned.id)
    expect(firstRun).toMatch(/^mock-c2b-run-/)

    // The lead run completes. The intent row stays 'dispatched' (no success-terminal
    // status exists) — but it must now be retired BY DERIVATION.
    setRunStatus(firstRun!, 'done')
    expect(leadDispatchDb.getActiveLeadDispatchByAssignment.get(assigned.id)).toBeUndefined()

    // Latent pre-C2 wedge: this follow-up used to throw at guard 1 ("already
    // dispatched") forever. A terminal prior run is a legitimate follow-up now.
    const again = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as { status: string }
    expect(again.status).toBe('pending')
    await drainLeadDispatches()
    const secondRun = leadRunIdFor(assigned.id)
    expect(secondRun).toMatch(/^mock-c2b-run-/)
    expect(secondRun).not.toBe(firstRun) // the relay overwrote the link with the new wave's run
  })

  it('(1) end-to-end: dispatch → terminal → reassign 200 → dispatch the NEW lead → drain', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'reassign flow' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const firstRun = leadRunIdFor(assigned.id)!
    setRunStatus(firstRun, 'done')

    // Reassign succeeds: guard 1 sees a terminal run, guard 2 sees the completed
    // intent retired-by-derivation (this 200 IS the blocker regression assertion).
    const res = await app.inject({
      method: 'PATCH', url: `/api/chief/assignments/${assigned.id}`, headers: AUTH,
      payload: { leadProfileId: 'lead-systems' },
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json() as Assignment
    expect(updated.lead).toBe('Systems')
    expect(updated.leadRunId).toBeNull()

    // The NEW lead is dispatchable: intent resolves lead-systems, the relay executes it.
    const redo = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as { status: string; leadProfileId: string }
    expect(redo.status).toBe('pending')
    expect(redo.leadProfileId).toBe('lead-systems')
    await drainLeadDispatches()
    const newRun = leadRunIdFor(assigned.id)
    expect(newRun).toMatch(/^mock-c2b-run-/)
    expect(newRun).not.toBe(firstRun)
  })

  it('(3a) a genuinely PENDING intent still blocks dispatch_lead AND reassign', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'pending blocks' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) // pending — never drained

    expect(() => call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)).toThrow(MgmtError)
    const res = await app.inject({
      method: 'PATCH', url: `/api/chief/assignments/${assigned.id}`, headers: AUTH,
      payload: { leadProfileId: 'lead-systems' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('assignment has a pending dispatch')
  })

  it('(3b) a DISPATCHED intent with a LIVE run still blocks (both surfaces + the statement)', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'live blocks' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches() // mock run stays 'running' → live

    // Statement: still active. dispatch_lead: guard 1 (live linked run) throws.
    expect(leadDispatchDb.getActiveLeadDispatchByAssignment.get(assigned.id)).toBeDefined()
    expect(() => call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)).toThrow(/is live/)

    // Reassign: guard 1 (assignment's live lead run) → 409.
    const res = await app.inject({
      method: 'PATCH', url: `/api/chief/assignments/${assigned.id}`, headers: AUTH,
      payload: { leadProfileId: 'lead-systems' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('lead run is live')

    // Guard 2 pinned in isolation: a dispatched intent with a live run while the
    // ASSIGNMENT link is empty (the relay's wiring window) → the intent alone 409s.
    const liveRun = `mock-c2b-run-${uuid().slice(0, 8)}`
    insertRunRow(liveRun, 'running')
    const bare = call('assign_lead', { lead: 'Backend', objective: 'wiring window' }, ctxChief) as Assignment
    insertIntent(bare.id, { status: 'dispatched', leadRunId: liveRun })
    const res2 = await app.inject({
      method: 'PATCH', url: `/api/chief/assignments/${bare.id}`, headers: AUTH,
      payload: { leadProfileId: 'lead-systems' },
    })
    expect(res2.statusCode).toBe(409)
    expect((res2.json() as { error: string }).error).toBe('assignment has a pending dispatch')
  })

  it('(3c) a DISPATCHED intent with lead_run_id NULL (claim-window orphan) still blocks fail-safe', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'orphan blocks' }, ctxChief) as Assignment
    insertIntent(assigned.id, { status: 'dispatched', leadRunId: null })

    // The derivation cannot prove the run was never spawned — it blocks until the
    // boot sweep (reconcileOrphanedLeadDispatches) marks the orphan failed.
    expect(leadDispatchDb.getActiveLeadDispatchByAssignment.get(assigned.id)).toBeDefined()
    expect(() => call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)).toThrow(MgmtError)
    const res = await app.inject({
      method: 'PATCH', url: `/api/chief/assignments/${assigned.id}`, headers: AUTH,
      payload: { leadProfileId: 'lead-systems' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('assignment has a pending dispatch')
  })
})
