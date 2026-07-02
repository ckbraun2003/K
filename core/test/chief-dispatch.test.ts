/**
 * chief-dispatch.ts + the mgmt `dispatch_lead` tool — the Chief→lead DISPATCH hop
 * (loop-a, P5.4). The downward mirror of the K→Chief precedent (chief-wake.test.ts).
 *
 * `supervisor.startRun` is mocked (same pattern as chief-wake / agent-runs tests) so no
 * real agent spawns; the mock inserts a real `runs` row because both `agent_runs.run_id`
 * and `mgmt_assignments.lead_run_id` have FOREIGN KEYs → runs(id). Modules that
 * transitively import the mocked supervisor (mgmt.js via agent-runs.js, chief-dispatch.js)
 * are imported AFTER the mock is registered.
 *
 * Durable profiles (seedProfiles) and workflow templates (seedWorkflowDefinitions) are
 * seeded in beforeAll so 'Frontend'/'lead-backend'/code-wave/investigate resolve. A real
 * Chief `runs` row (CHIEF_RUN) is the delegation parent. Cleanup is cautious: our mgmt
 * rows + mock runs + our fixture runs only — the shared durable seeds are left intact.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb, mgmtDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
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

// ── fixtures + helpers ────────────────────────────────────────────────────────

const CHIEF_RUN = uuid() // the delegation parent (a real runs row)
const RUN_B = uuid() // a second, distinct run (ownership test)
const ROLLBACK_MARKER = 'ROLLBACK-MARKER-cd'

type Ctx = { runId: string | null }
const ctxChief: Ctx = { runId: CHIEF_RUN }
const ctxB: Ctx = { runId: RUN_B }

/** Invoke a mgmt tool by name through the registry (as the server would). Returns the
 *  raw handler result — sync tools return the value, `dispatch_lead` returns a Promise. */
function call(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

interface DispatchResult {
  assignmentId: string
  leadProfileId: string
  agentRunId: string
  runId: string
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
  // FK-safe order: events (RESTRICT) → mgmt rows → agent_runs (SET NULL) → runs.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-cd-run-%'`).run()
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id IN (?, ?)`).run(CHIEF_RUN, RUN_B)
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-cd-run-%'`).run()
  db.prepare(`DELETE FROM agent_runs WHERE run_id IS NULL AND goal LIKE ?`).run(`%${ROLLBACK_MARKER}%`)
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

// ── dispatch_lead (execution) ────────────────────────────────────────────────

describe('mgmt: dispatch_lead', () => {
  it('activates the lead as a delegation run and records the Chief→lead link', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'X' }, ctxChief) as Assignment
    const res = (await call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)) as DispatchResult

    expect(res.leadProfileId).toBe('lead-frontend')
    expect(typeof res.runId).toBe('string')
    expect(res.runId.length).toBeGreaterThan(0)

    // A new agent_runs activation: the lead profile, delegation trigger, seeded goal, workflow.
    const arRow = agentRunsDb.getAgentRun.get(res.agentRunId) as Record<string, unknown>
    expect(arRow.profile_id).toBe('lead-frontend')
    expect(arRow.trigger).toBe('delegation')
    expect(String(arRow.goal)).toContain('X')
    expect(arRow.workflow_id).toBe('code-wave')

    // The parent→child link is DB-derivable: assignment.run_id === CHIEF_RUN,
    // assignment.lead_run_id === the lead run id.
    const aRow = mgmtDb.getAssignment.get(assigned.id) as Record<string, unknown>
    expect(aRow.run_id).toBe(CHIEF_RUN)
    expect(aRow.lead_run_id).toBe(res.runId)
  })

  it('rejects a second dispatch of the same assignment (double-dispatch guard)', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'once only' }, ctxChief) as Assignment
    await call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await expect(
      call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as Promise<unknown>,
    ).rejects.toThrow(MgmtError)
  })

  it('cannot dispatch another run\'s assignment (ownership)', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'chief-owned' }, ctxChief) as Assignment
    await expect(
      call('dispatch_lead', { assignmentId: assigned.id }, ctxB) as Promise<unknown>,
    ).rejects.toThrow(MgmtError)
  })

  it('rejects when no lead profile matches the assignment lead', async () => {
    const assigned = call('assign_lead', { lead: 'nobody', objective: 'no lead' }, ctxChief) as Assignment
    await expect(
      call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as Promise<unknown>,
    ).rejects.toThrow(MgmtError)
    // never dispatched — link stays null.
    const aRow = mgmtDb.getAssignment.get(assigned.id) as Record<string, unknown>
    expect(aRow.lead_run_id).toBeNull()
  })

  it('seeds the lead run from an explicitly chosen workflow (Investigate)', async () => {
    const assigned = call('assign_lead', { lead: 'Backend', objective: 'look into the flake' }, ctxChief) as Assignment
    call('pick_workflow', { assignmentId: assigned.id, workflow: 'Investigate' }, ctxChief)
    const res = (await call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)) as DispatchResult

    const arRow = agentRunsDb.getAgentRun.get(res.agentRunId) as Record<string, unknown>
    expect(arRow.workflow_id).toBe('investigate')
    const goal = String(arRow.goal)
    expect(goal.includes('research loop') || goal.includes('Investigator')).toBe(true)
  })

  it('a dispatch failure leaves lead_run_id NULL (retryable) and no completed lead run', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'))
    const assigned = call(
      'assign_lead',
      { lead: 'Frontend', objective: `${ROLLBACK_MARKER} dispatch that fails` },
      ctxChief,
    ) as Assignment

    await expect(
      call('dispatch_lead', { assignmentId: assigned.id }, ctxChief) as Promise<unknown>,
    ).rejects.toThrow()

    // The assignment link is untouched — the Chief can retry.
    const aRow = mgmtDb.getAssignment.get(assigned.id) as Record<string, unknown>
    expect(aRow.lead_run_id).toBeNull()
    // No lead activation for this objective finished 'completed' (startAgentRun rolled it
    // back to 'failed' before re-throwing).
    const rows = agentRunsDb.listAgentRunsByProfile.all('lead-frontend') as Array<Record<string, unknown>>
    const mine = rows.filter(r => String(r.goal).includes(ROLLBACK_MARKER))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(r => r.status !== 'completed')).toBe(true)
  })
})

// ── report-back (lead → Chief mgmt store) ────────────────────────────────────

describe('chief-dispatch: report-back', () => {
  it('files a report UP to the Chief on the lead run terminal (with summary)', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'report please' }, ctxChief) as Assignment
    const res = (await call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)) as DispatchResult

    insertAssistantEvent(res.runId, 'Frontend lead: shipped the PR.')
    eventBus.emitRunUpdate(terminalRun(res.runId, 'done'))
    await flush()

    const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 20) as Array<Record<string, unknown>>
    const match = reports.filter(
      r => String(r.body).includes('Lead') && String(r.body).includes('completed'),
    )
    expect(match.length).toBeGreaterThan(0)
    expect(match.some(r => String(r.body).includes('shipped the PR'))).toBe(true)
  })

  it('reports "no summary was produced" when the lead run emitted no assistant text', async () => {
    const assigned = call('assign_lead', { lead: 'Frontend', objective: 'silent lead' }, ctxChief) as Assignment
    const res = (await call('dispatch_lead', { assignmentId: assigned.id }, ctxChief)) as DispatchResult

    eventBus.emitRunUpdate(terminalRun(res.runId, 'done'))
    await flush()

    const reports = mgmtDb.listReportsByRun.all(CHIEF_RUN, 20) as Array<Record<string, unknown>>
    expect(reports.some(r => String(r.body).includes('no summary was produced'))).toBe(true)
  })
})
