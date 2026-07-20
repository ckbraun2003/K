/**
 * W8a — HIGH org-pipeline relay-core fixes (the autonomous K→Chief→lead chain seams).
 *
 * Pins the five fixes that keep the chain from dying at Chief→lead and give the lead a
 * real checklist:
 *   - F-067: the `lead_list` roster tool, the AUTO-path roster injection (wake goal +
 *     no-hint delegation seed), and assign_lead resolving/rejecting a lead the SAME way
 *     dispatch_lead does (so "engineering" fails FAST at assign time, not later).
 *   - F-070: a dispatched lead run is bound to a `workflow_runs` row + a seeded checklist,
 *     so its kstore status-write tools RESOLVE (no longer `not_in_workflow`).
 *   - F-072: finalizeWorkflowRun reconciles lingering non-terminal steps so the checklist
 *     can't contradict the completed/failed row.
 *   - F-071: a CI/PR gate step can't be marked done without PR evidence.
 *
 * supervisor.startRun is mocked (mirrors lead-dispatch-relay.test.ts) so no real agent
 * spawns; the mock inserts a real `runs` row because agent_runs.run_id / lead_dispatches.
 * lead_run_id / mgmt_assignments.lead_run_id / workflow_runs.run_id all FK → runs(id).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db, mgmtDb, workflowRunsDb, workflowStepsDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { seedProfiles } from '../src/profiles.js'
import { seedWorkflowDefinitions } from '../src/workflow-defs.js'
import { DEFAULT_CHIEF_WAKE_GOAL } from '../src/chief-wake.js'
import type { Assignment, Run, WorkflowStep } from '@k/shared'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-w8a-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'w8a', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

// Imported AFTER the mock so the transitive supervisor is mocked.
const { mgmtTools, MgmtError } = await import('../src/mcp/mgmt.js')
const { drainLeadDispatches } = await import('../src/lead-dispatch-relay.js')
const { leadRosterHint, listDispatchableLeads } = await import('../src/chief-dispatch.js')
const { finalizeWorkflowRun } = await import('../src/workflows.js')
const { kStoreTools } = await import('../src/mcp/k-store.js')

// ── fixtures + helpers ────────────────────────────────────────────────────────

const CHIEF_RUN = uuid()
const PROJECT_ID = `w8a-proj-${uuid().slice(0, 8)}`
const PROJECT_NAME = PROJECT_ID
let projectDir = ''

type Ctx = { runId: string | null }
const ctxChief: Ctx = { runId: CHIEF_RUN }

function mcall(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}
function kcall(name: string, args: unknown, ctx: Ctx): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}
const flush = () => new Promise(r => setTimeout(r, 30))
const terminalRun = (id: string, status: Run['status'] = 'done'): Run =>
  ({ id, status, tokensIn: 0, tokensOut: 0, costUsd: 0 }) as Run

function insertRunRow(id: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'w8a', '.', ?, ?)`,
  ).run(id, status, Date.now())
}

const assignmentLeadRun = (assignmentId: string) =>
  String((mgmtDb.getAssignment.get(assignmentId) as Record<string, unknown>).lead_run_id)

/** A run + workflow_run bound to it (for the pure kstore/finalize tests). */
function seedBoundWorkflow(): { runId: string; wfId: string; ctx: Ctx } {
  const runId = uuid()
  const wfId = uuid()
  insertRunRow(runId)
  workflowRunsDb.insertWorkflowRun.run({
    id: wfId, projectId: PROJECT_ID, runId, taskIds: '[]', mode: 'combined',
    workflowId: null, status: 'running', createdAt: Date.now(), completedAt: null,
  })
  return { runId, wfId, ctx: { runId } }
}

beforeAll(() => {
  seedProfiles()
  seedWorkflowDefinitions()
  insertRunRow(CHIEF_RUN)
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-w8a-'))
  db.prepare(`INSERT INTO projects (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`)
    .run(PROJECT_ID, PROJECT_NAME, projectDir, Date.now())
})

afterAll(() => {
  // FK-safe: workflow_steps/workflow_runs cascade from the project; then dispatch/mgmt rows;
  // agent_runs (SET NULL) → runs → projects. Only our rows; shared durable seeds stay.
  db.prepare(`DELETE FROM events WHERE run_id LIKE 'mock-w8a-run-%'`).run()
  db.prepare(`DELETE FROM workflow_runs WHERE project_id = ?`).run(PROJECT_ID) // cascades workflow_steps
  db.prepare(`DELETE FROM mgmt_reports WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM lead_dispatches WHERE chief_run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM mgmt_assignments WHERE run_id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-w8a-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-w8a-run-%'`).run()
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(CHIEF_RUN)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(PROJECT_ID)
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── F-067: the lead roster (tool + seeds + validation) ───────────────────────

describe('F-067: lead roster tool, seed injection, and assign-time validation', () => {
  const LEAD_IDS = ['lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']

  it('listDispatchableLeads + lead_list return exactly the five discipline leads', () => {
    const leads = listDispatchableLeads()
    expect(leads.map(l => l.id).sort()).toEqual([...LEAD_IDS].sort())

    const listed = mcall('lead_list', {}, ctxChief) as Array<{ id: string; name: string; discipline: string; role: string }>
    expect(listed.map(l => l.id).sort()).toEqual([...LEAD_IDS].sort())
    const frontend = listed.find(l => l.id === 'lead-frontend')!
    expect(frontend.name).toBe('Frontend')
    expect(frontend.discipline).toBe('frontend')
    expect(frontend.role).toMatch(/assign with/i) // the how-to-reference note
  })

  it('leadRosterHint names every lead + points at lead_list (never an invented discipline)', () => {
    const hint = leadRosterHint()
    for (const id of LEAD_IDS) expect(hint).toContain(id)
    expect(hint).toContain('Frontend')
    expect(hint).toContain('lead_list')
    expect(hint).toContain('invented discipline')
  })

  it('DEFAULT_CHIEF_WAKE_GOAL (the AUTO wake seed) names the leads + lead_list', () => {
    for (const id of LEAD_IDS) expect(DEFAULT_CHIEF_WAKE_GOAL).toContain(id)
    expect(DEFAULT_CHIEF_WAKE_GOAL).toContain('lead_list')
  })

  it('assign_lead resolves a name/slug/id to the canonical lead NAME', () => {
    for (const [input, name] of [['frontend', 'Frontend'], ['Frontend', 'Frontend'], ['lead-backend', 'Backend'], ['Backend lead', 'Backend']] as const) {
      const a = mcall('assign_lead', { lead: input, objective: `canon ${input}` }, ctxChief) as Assignment
      expect(a.lead).toBe(name)
    }
  })

  it('assign_lead rejects an unknown lead FAST, naming valid leads (F-067 — assign+dispatch agree)', () => {
    let msg = ''
    try {
      mcall('assign_lead', { lead: 'engineering', objective: 'no lead' }, ctxChief)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('no lead profile matches')
    expect(msg).toContain('lead-frontend')
    expect(() => mcall('assign_lead', { lead: 'engineering', objective: 'x' }, ctxChief)).toThrow(MgmtError)
  })
})

// ── F-070: a dispatched lead gets a bound workflow_run + seeded checklist ─────

describe('F-070: the relay binds a lead run to a workflow_run + seeds its checklist', () => {
  it('a scoped lead dispatch creates a workflow_run + seeded steps; workflow_step_set resolves', async () => {
    const assigned = mcall('assign_lead', { lead: 'Frontend', objective: 'F070 objective' }, ctxChief) as Assignment
    mcall('scope_projects', { assignmentId: assigned.id, projects: [PROJECT_NAME] }, ctxChief)
    mcall('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    expect(await drainLeadDispatches()).toBe(1)

    const leadRunId = assignmentLeadRun(assigned.id)
    expect(leadRunId).toMatch(/^mock-w8a-run-/)

    // A workflow_run now exists BOUND to the lead run (the row kstore resolves from K_RUN_ID).
    const wf = workflowStepsDb.getWorkflowRunByRunId.get(leadRunId) as Record<string, unknown> | undefined
    expect(wf).toBeTruthy()
    expect(wf!.workflow_id).toBe('code-wave')
    expect(wf!.project_id).toBe(PROJECT_ID)
    expect(wf!.status).toBe('running')

    // The checklist is SEEDED (one pending step per code-wave role), not empty.
    const steps = workflowStepsDb.listWorkflowSteps.all(String(wf!.id)) as WorkflowStep[]
    expect(steps.length).toBeGreaterThanOrEqual(4)
    expect(steps.every(s => s.status === 'pending')).toBe(true)

    // The lead's status-write tools now RESOLVE (no longer `not_in_workflow`).
    const step = kcall('workflow_step_set', { label: 'Implement', kind: 'task', status: 'in_progress' }, { runId: leadRunId }) as WorkflowStep
    expect(step.workflowRunId).toBe(String(wf!.id))
    const overall = kcall('workflow_status_set', { status: 'running' }, { runId: leadRunId }) as { ok: boolean }
    expect(overall.ok).toBe(true)
  })

  it('the lead terminal finalizes the workflow_run completed + reconciles lingering steps (F-072)', async () => {
    const assigned = mcall('assign_lead', { lead: 'Backend', objective: 'F070 finalize' }, ctxChief) as Assignment
    mcall('scope_projects', { assignmentId: assigned.id, projects: [PROJECT_NAME] }, ctxChief)
    mcall('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const leadRunId = assignmentLeadRun(assigned.id)
    const wfId = String((workflowStepsDb.getWorkflowRunByRunId.get(leadRunId) as Record<string, unknown>).id)

    // The lead run terminates 'done' → the seeded pending steps must reconcile.
    eventBus.emitRunUpdate(terminalRun(leadRunId, 'done'))
    await flush()

    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { status: string }).status).toBe('completed')
    const steps = workflowStepsDb.listWorkflowSteps.all(wfId) as WorkflowStep[]
    expect(steps.some(s => s.status === 'pending' || s.status === 'in_progress')).toBe(false)
  })

  it('an UNSCOPED lead dispatch gets no workflow_run (project_id is NOT NULL) — unchanged', async () => {
    const assigned = mcall('assign_lead', { lead: 'Systems', objective: 'F070 unscoped' }, ctxChief) as Assignment
    mcall('dispatch_lead', { assignmentId: assigned.id }, ctxChief)
    await drainLeadDispatches()
    const leadRunId = assignmentLeadRun(assigned.id)
    expect(workflowStepsDb.getWorkflowRunByRunId.get(leadRunId)).toBeUndefined()
  })
})

// ── F-071: a CI/PR gate step needs evidence to be marked done ─────────────────

describe('F-071: a CI/PR gate step cannot be marked done without PR evidence', () => {
  it('ci + done with NO evidence is rejected; with a PR reference/url it succeeds', () => {
    const { ctx } = seedBoundWorkflow()

    // No evidence → rejected.
    expect(() => kcall('workflow_step_set', { label: 'CI gate', kind: 'ci', status: 'done' }, ctx)).toThrow()
    expect(() => kcall('workflow_step_set', { label: 'CI gate', kind: 'ci', status: 'done', detail: 'all green' }, ctx)).toThrow()

    // A PR url OR a #number counts as evidence.
    const withUrl = kcall(
      'workflow_step_set',
      { label: 'CI gate', kind: 'ci', status: 'done', detail: 'opened https://github.com/o/r/pull/12 — CI green' },
      ctx,
    ) as WorkflowStep
    expect(withUrl.status).toBe('done')

    const withNum = kcall('workflow_step_set', { label: 'CI num', kind: 'ci', status: 'done', detail: 'PR #42 merged' }, ctx) as WorkflowStep
    expect(withNum.status).toBe('done')
  })

  it('a non-gate step (task) can still be marked done with no PR reference — unaffected', () => {
    const { ctx } = seedBoundWorkflow()
    const step = kcall('workflow_step_set', { label: 'Implement X', kind: 'task', status: 'done' }, ctx) as WorkflowStep
    expect(step.status).toBe('done')
  })
})

// ── F-072: finalize reconciles lingering steps directly ───────────────────────

describe('F-072: finalizeWorkflowRun reconciles lingering non-terminal steps', () => {
  it('after finalize, pending/in_progress steps become blocked; done steps are untouched', () => {
    const { wfId, ctx } = seedBoundWorkflow()
    kcall('workflow_step_set', { label: 'A', kind: 'task', status: 'in_progress' }, ctx)
    kcall('workflow_step_set', { label: 'B', kind: 'phase', status: 'pending' }, ctx)
    kcall('workflow_step_set', { label: 'C', kind: 'task', status: 'done', detail: 'shipped' }, ctx)

    finalizeWorkflowRun(wfId, 'done')

    expect((workflowRunsDb.getWorkflowRun.get(wfId) as { status: string }).status).toBe('completed')
    const byLabel = Object.fromEntries(
      (workflowStepsDb.listWorkflowSteps.all(wfId) as WorkflowStep[]).map(s => [s.label, s.status]),
    )
    expect(byLabel.A).toBe('blocked')
    expect(byLabel.B).toBe('blocked')
    expect(byLabel.C).toBe('done') // a real terminal is preserved
  })
})
