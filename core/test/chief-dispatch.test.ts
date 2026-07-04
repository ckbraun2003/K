/**
 * chief-dispatch.ts + the mgmt `dispatch_lead` tool — the Chief→lead DISPATCH hop
 * (loop-a P5.4, DECOUPLED in loop-b). The downward mirror of the K→Chief precedent
 * (chief-wake.test.ts).
 *
 * TWO-PHASE FLOW (loop-b): `dispatch_lead` runs in the ephemeral mgmt-server child, so it
 * only RECORDS a 'pending' intent into the `lead_dispatches` queue (returns
 * { assignmentId, leadProfileId, workflowId, dispatchId, status:'pending' } — no run yet).
 * The MAIN-process relay's `drainLeadDispatches()` claims + EXECUTES each intent
 * (startAgentRun), records the Chief→lead link, and wires the report-back. These tests
 * exercise BOTH phases: assert the intent at record time, then drain and assert the run.
 *
 * `supervisor.startRun` is mocked (same pattern as chief-wake / agent-runs tests) so no
 * real agent spawns; the mock inserts a real `runs` row because both `agent_runs.run_id`
 * and `mgmt_assignments.lead_run_id` have FOREIGN KEYs → runs(id). Modules that
 * transitively import the mocked supervisor (mgmt.js via db, chief-dispatch.js, the relay
 * via agent-runs.js) are imported AFTER the mock is registered.
 *
 * Durable profiles (seedProfiles) and workflow templates (seedWorkflowDefinitions) are
 * seeded in beforeAll so 'Frontend'/'lead-backend'/code-wave/investigate resolve. A real
 * Chief `runs` row (CHIEF_RUN) is the delegation parent. Cleanup is cautious: our mgmt
 * rows + dispatch intents + mock runs + our fixture runs only — the shared durable seeds
 * are left intact.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb, mgmtDb, leadDispatchDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { seedProfiles } from '../src/profiles.js'
import { seedWorkflowDefinitions } from '../src/workflow-defs.js'
import type { Assignment, Run } from '@k/shared'

// startRun mocked so no real agent spawns, but it MUST insert a real runs row:
// agent_runs.run_id and mgmt_assignments.lead_run_id both FK → runs(id).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-cd-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'cd', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Modules under test — imported AFTER the mock so the transitive supervisor is mocked.
const { mgmtTools, MgmtError } = await import('../src/mcp/mgmt.js')
const { resolveLeadProfileId, resolveLeadWorkflow, buildLeadSeed } = await import('../src/chief-dispatch.js')
const { drainLeadDispatches } = await import('../src/lead-dispatch-relay.js')

// ── fixtures + helpers ────────────────────────────────────────────────────────

const CHIEF_RUN = uuid() // the delegation parent (a real runs row)
const RUN_B = uuid() // a second, distinct run (ownership test)

type Ctx = { runId: string | null }
const ctxChief: Ctx = { runId: CHIEF_RUN }
const ctxB: Ctx = { runId: RUN_B }

/** Invoke a mgmt tool by name through the registry (as the server would). Returns the
 *  raw handler result — every mgmt tool is now sync (storage/record only). */
function call(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

/** What `dispatch_lead` returns now: the recorded intent (no run yet). */
interface DispatchResult {
  assignmentId: string
  leadProfileId: string
  workflowId: string
  dispatchId: string
  status: 'pending'
}

/** The lead run id the relay recorded for a drained intent (via the assignment link). */
function leadRunIdFor(assignmentId: string): string {
  const a = mgmtDb.getAssignment.get(assignmentId) as Record<string, unknown>
  return String(a.lead_run_id)
}

/** Let a fire-and-forget lifecycle settle (the report-back rides the async seam). */
const flush = () => new Promise(r => setTimeout(r, 30))

/** A terminal Run event for `id` (minimal shape the run-lifecycle seam reads). */
function terminalRun(id: string, status: Run['status'] = 'done'): Run {
  return { id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run
}

/** Insert a real runs row so an FK-bound row/event has a target. */
function insertRunRow(id: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'cd', '.', ?, ?)`,
  ).run(id, status, Date.now())
}

/** Insert a single `assistant` event for a run so the report-back summary is non-empty. */
function insertAssistantEvent(runId: string, text: string): void {
  db.prepare(
    `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'assistant', ?, ?)`,
  ).run(uuid(), runId, 1, Date.now(), text)
}

beforeAll(() => {
  // Idempotent shared seeds — create the durable lead roster + workflow templates if a
  // prior suite hasn't already. We do NOT delete these in afterAll (they are the
  // standard durable state other suites also rely on).
  seedProfiles()
  seedWorkflowDefinitions()
  insertRunRow(CHIEF_RUN)
  insertRunRow(RUN_B)
})

afterAll(() => {
  // FK-safe order: events → mgmt_reports → lead_dispatches → mgmt_assignments →
  // agent_runs (SET NULL) → runs.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-cd-run-%'`).run()
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
  db.prepare(`DELETE FROM lead_dispatches WHERE chief_run_id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-cd-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-cd-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
})

// ── pure seam helpers ──────────────────────────────────────────────────────────

describe('chief-dispatch: pure resolvers', () => {
  it('resolveLeadProfileId maps id/name/slug to a lead; non-leads → null', () => {
    expect(resolveLeadProfileId('lead-frontend')).toBe('lead-frontend')
    expect(resolveLeadProfileId('Frontend')).toBe('lead-frontend')
    expect(resolveLeadProfileId('frontend')).toBe('lead-frontend')
    expect(resolveLeadProfileId('Backend lead')).toBe('lead-backend')
    expect(resolveLeadProfileId('orchestrator')).toBeNull()
    expect(resolveLeadProfileId('default-orchestrator')).toBeNull()
    expect(resolveLeadProfileId('nonsense')).toBeNull()
  })

  it('resolveLeadWorkflow resolves by id/name, defaults + falls back to code-wave', () => {
    expect(resolveLeadWorkflow('code-wave').workflowId).toBe('code-wave')
    expect(resolveLeadWorkflow('Investigate').workflowId).toBe('investigate')
    expect(resolveLeadWorkflow(null).workflowId).toBe('code-wave')
    expect(resolveLeadWorkflow('bogus-nope').workflowId).toBe('code-wave')
    // a resolved workflow always carries a non-empty scaffold
    expect(resolveLeadWorkflow(null).scaffold.length).toBeGreaterThan(0)
  })

  it('buildLeadSeed renders the objective as the single checklist item + charter, no raw token', () => {
    const { scaffold } = resolveLeadWorkflow('code-wave')
    const seed = buildLeadSeed('Ship the auth refactor', scaffold)
    expect(seed).toContain('1. [ ] Ship the auth refactor')
    expect(seed).toContain('PULL REQUEST')
    expect(seed).not.toContain('{{CHECKLIST}}')
  })
})

// ── dispatch_lead (RECORD) + relay drain (EXECUTE) ───────────────────────────

describe('mgmt: dispatch_lead', () => {
  it('records a pending intent, then the relay drain activates the lead + links the assignment', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'X' }, ctxChief) as Assignment
    const res = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as DispatchResult

    // Phase 1 — RECORD: a pending intent with the resolved profile/workflow/goal, no run yet.
    expect(res.status).toBe('pending')
    expect(res.leadProfileId).toBe('lead-frontend')
    expect(res.workflowId).toBe('code-wave')
    const intent = leadDispatchDb.getLeadDispatch.get(res.dispatchId) as Record<string, unknown>
    expect(intent.status).toBe('pending')
    expect(intent.chief_run_id).toBe(CHIEF_RUN)
    expect(String(intent.goal)).toContain('X')
    expect(intent.lead_run_id).toBeNull()
    // No lead activation yet, and the assignment link is still NULL.
    expect(mgmtDb.getAssignment.get(assigned.id) as Record<string, unknown>).toMatchObject({ lead_run_id: null })

    // Phase 2 — DRAIN: the relay executes the intent in the main process.
    await drainLeadDispatches()

    const runId = leadRunIdFor(assigned.id)
    expect(runId).toMatch(/^mock-cd-run-/)
    // A new agent_runs activation: the lead profile, delegation trigger, seeded goal, workflow.
    const arRow = agentRunsDb.getAgentRunProfileByRunId.get(runId) as { profile_id: string }
    expect(arRow.profile_id).toBe('lead-frontend')
    const ar = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>
    expect(ar.trigger).toBe('delegation')
    expect(String(ar.goal)).toContain('X')
    expect(ar.workflow_id).toBe('code-wave')
    // The intent is retired 'dispatched' with the run id recorded, and the Chief→lead link
    // is DB-derivable: assignment.run_id === CHIEF_RUN, assignment.lead_run_id === run id.
    const doneIntent = leadDispatchDb.getLeadDispatch.get(res.dispatchId) as Record<string, unknown>
    expect(doneIntent.status).toBe('dispatched')
    expect(doneIntent.lead_run_id).toBe(runId)
    expect(mgmtDb.getAssignment.get(assigned.id) as Record<string, unknown>).toMatchObject({ run_id: CHIEF_RUN, lead_run_id: runId })
  })

  it('rejects a second dispatch of the same assignment (pending-intent guard)', () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'once only' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    expect(() => call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)).toThrow(MgmtError)
  })

  it('cannot dispatch another run\'s assignment (ownership)', () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'chief-owned' }, ctxChief) as Assignment
    expect(() => call('dispatch_lead', { assignmentId: assigned.id }, ctxB)).toThrow(MgmtError)
  })

  it('rejects an unknown lead at ASSIGN time (F-067 — assign + dispatch agree), naming valid leads', () => {
    // F-067: assign_lead now resolves the lead the SAME way dispatch_lead does, so a bogus
    // lead like "engineering" fails FAST at assign time (no dangling assignment) with a
    // message that names the valid leads — instead of being accepted then rejected only later.
    let msg = ''
    try {
      call('assign_lead', { lead: 'engineering', objective: 'no lead' }, ctxChief)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('no lead profile matches')
    expect(msg).toContain('Frontend')
    expect(msg).toContain('lead-backend')
    // Nothing was persisted — no assignment row to dispatch.
    expect(() => call('assign_lead', { lead: 'engineering', objective: 'x' }, ctxChief)).toThrow(MgmtError)
  })

  it('records an intent seeded from an explicitly chosen workflow (Investigate)', () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'look into the flake' }, ctxChief) as Assignment
    call('pick_workflow', { assignmentId: assigned.id, workflow: 'Investigate' }, ctxChief)
    const res = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as DispatchResult

    expect(res.workflowId).toBe('investigate')
    const intent = leadDispatchDb.getLeadDispatch.get(res.dispatchId) as Record<string, unknown>
    expect(intent.workflow_id).toBe('investigate')
    const goal = String(intent.goal)
    expect(goal.includes('research loop') || goal.includes('Investigator')).toBe(true)
  })

  it('record does NOT dispatch — no lead activation is created until the relay drains', () => {
    // dispatch_lead only RECORDS (no startAgentRun call), so it never creates an agent_runs
    // activation. Execution — and any dispatch failure — is the relay's job (covered in
    // lead-dispatch-relay.test.ts). No drain here → the activation count must be unchanged.
    const before = (agentRunsDb.listAgentRunsByProfile.all('lead-frontend') as unknown[]).length
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'record-not-dispatch' }, ctxChief) as Assignment
    const res = call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as DispatchResult
    expect(res.status).toBe('pending')
    expect((agentRunsDb.listAgentRunsByProfile.all('lead-frontend') as unknown[]).length).toBe(before)
  })
})

// ── report-back (lead → Chief mgmt store) via the relay ──────────────────────

describe('chief-dispatch: report-back', () => {
  it('files a report UP to the Chief on the lead run terminal (with summary)', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'report please' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const runId = leadRunIdFor(assigned.id)

    insertAssistantEvent(runId, 'Frontend lead: shipped the PR.')
    eventBus.emitRunUpdate(terminalRun(runId, 'done'))
    await flush()

    const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 50) as Array<Record<string, unknown>>
    const match = reports.filter(
      r => String(r.body).includes('Lead') && String(r.body).includes('completed'),
    )
    expect(match.length).toBeGreaterThan(0)
    expect(match.some(r => String(r.body).includes('shipped the PR'))).toBe(true)
  })

  it('reports "no summary was produced" when the lead run emitted no assistant text', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'silent lead' }, ctxChief) as Assignment
    call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const runId = leadRunIdFor(assigned.id)

    eventBus.emitRunUpdate(terminalRun(runId, 'done'))
    await flush()

    const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 50) as Array<Record<string, unknown>>
    expect(reports.some(r => String(r.body).includes('no summary was produced'))).toBe(true)
  })
})
