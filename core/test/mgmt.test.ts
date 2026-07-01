/**
 * mgmt store-layer units (P5.2a).
 *
 * Exercises the SDK-free tool handlers in core/src/mcp/mgmt.ts directly through the
 * `mgmtTools` registry, against the real DB singleton with run fixtures. Covers the
 * assign→pick_workflow→scope_projects→report flow, the K_RUN_ID→owner resolution
 * (bogus run degrades to a null owner, no FK error), error paths (bad id → MgmtError
 * → not found), and — crucially — RUN SCOPING (one run can neither read nor mutate
 * another run's assignments). The MCP transport glue (mgmt-server.ts) is intentionally
 * not unit-tested here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb } from '../src/db.js'
import { mgmtTools, MgmtError, type MgmtContext } from '../src/mcp/mgmt.js'
import type { Assignment, MgmtReport } from '@k/shared'

// ── fixtures: a project + two runs (owner + a second run) ─────────────────────
const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()

/** Invoke a mgmt tool by name through the registry (as the server would). */
function call(name: string, args: unknown, ctx: MgmtContext): unknown {
  const tool = mgmtTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such mgmt tool: ${name}`)
  return tool.handler(args, ctx)
}

const ctxA: MgmtContext = { runId: RUN_A }
const ctxB: MgmtContext = { runId: RUN_B }
const bogusCtx: MgmtContext = { runId: uuid() } // K_RUN_ID with no matching runs row
const noneCtx: MgmtContext = { runId: null }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID,
    name: `mgmt-test-${PROJECT_ID.slice(0, 8)}`,
    localPath: '/tmp/mgmt-test',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id,
      prompt: 'mgmt fixture',
      cwd: '/tmp/mgmt-test',
      worktree: null,
      status: 'running',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: PROJECT_ID,
      createdAt: Date.now(),
    })
  }
})

afterAll(() => {
  db.prepare('DELETE FROM mgmt_reports WHERE run_id IN (?, ?) OR run_id IS NULL').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM mgmt_assignments WHERE run_id IN (?, ?) OR run_id IS NULL').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('mgmt: assignments', () => {
  it('assign_lead persists a run-owned assignment (no workflow / empty scope yet)', () => {
    const a = call('assign_lead', { lead: 'Backend', objective: 'Ship auth refactor', note: 'high priority' }, ctxA) as Assignment
    expect(a.lead).toBe('Backend')
    expect(a.objective).toBe('Ship auth refactor')
    expect(a.note).toBe('high priority')
    expect(a.workflow).toBeNull()
    expect(a.projects).toEqual([])
    expect(a.runId).toBe(RUN_A)
    expect(a.createdAt).toBeGreaterThan(0)
  })

  it('pick_workflow records the workflow choice; scope_projects stores the project scope', () => {
    const a = call('assign_lead', { lead: 'Frontend', objective: 'Ship 3D graph' }, ctxA) as Assignment

    const withWf = call('pick_workflow', { assignmentId: a.id, workflow: 'code-wave' }, ctxA) as Assignment
    expect(withWf.workflow).toBe('code-wave')
    expect(withWf.projects).toEqual([]) // untouched
    expect(withWf.updatedAt).toBeGreaterThanOrEqual(a.updatedAt)

    const scoped = call('scope_projects', { assignmentId: a.id, projects: ['k', 'web'] }, ctxA) as Assignment
    expect(scoped.projects).toEqual(['k', 'web'])
    expect(scoped.workflow).toBe('code-wave') // still set — merge, not overwrite
    expect(scoped.objective).toBe('Ship 3D graph')
  })

  it('assign_lead rejects an empty objective (zod boundary)', () => {
    expect(() => call('assign_lead', { lead: 'Backend', objective: '' }, ctxA)).toThrow()
  })

  it('pick_workflow / scope_projects reject an unknown assignment id (MgmtError → not found)', () => {
    expect(() => call('pick_workflow', { assignmentId: uuid(), workflow: 'x' }, ctxA)).toThrow(MgmtError)
    expect(() => call('scope_projects', { assignmentId: uuid(), projects: [] }, ctxA)).toThrow(MgmtError)
  })

  it('a bogus K_RUN_ID degrades to a null owner instead of an FK error', () => {
    const a = call('assign_lead', { lead: 'Systems', objective: 'no real run' }, bogusCtx) as Assignment
    expect(a.runId).toBeNull()
    // the null-owner ctx can still address it; a real run cannot
    const owned = call('pick_workflow', { assignmentId: a.id, workflow: 'plain' }, noneCtx) as Assignment
    expect(owned.workflow).toBe('plain')
    expect(() => call('pick_workflow', { assignmentId: a.id, workflow: 'hijack' }, ctxA)).toThrow(MgmtError)
  })
})

describe('mgmt: reports', () => {
  it('report persists a run-owned report; assignmentId is optional', () => {
    const r = call('report', { body: 'all leads healthy' }, ctxA) as MgmtReport
    expect(r.body).toBe('all leads healthy')
    expect(r.assignmentId).toBeNull()
    expect(r.runId).toBe(RUN_A)
    expect(r.createdAt).toBeGreaterThan(0)
  })

  it('report can reference one of this run\'s assignments; a foreign id is rejected', () => {
    const a = call('assign_lead', { lead: 'Security', objective: 'Harden API' }, ctxA) as Assignment
    const r = call('report', { body: 'blocked on review', assignmentId: a.id }, ctxA) as MgmtReport
    expect(r.assignmentId).toBe(a.id)

    // an assignment owned by RUN_A is not addressable from RUN_B's report
    expect(() => call('report', { body: 'sneaky', assignmentId: a.id }, ctxB)).toThrow(MgmtError)
  })

  it('report rejects an empty body (zod boundary)', () => {
    expect(() => call('report', { body: '' }, ctxA)).toThrow()
  })
})

describe('mgmt: run scoping (a run cannot read or mutate another run\'s assignment)', () => {
  it('RUN_B cannot mutate RUN_A\'s assignment; owner still can', () => {
    const mine = call('assign_lead', { lead: 'Network', objective: 'A-owned objective' }, ctxA) as Assignment
    expect(() => call('pick_workflow', { assignmentId: mine.id, workflow: 'x' }, ctxB)).toThrow(MgmtError)
    expect(() => call('scope_projects', { assignmentId: mine.id, projects: ['x'] }, ctxB)).toThrow(MgmtError)
    const owned = call('scope_projects', { assignmentId: mine.id, projects: ['kept'] }, ctxA) as Assignment
    expect(owned.projects).toEqual(['kept'])
  })
})
