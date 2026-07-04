/**
 * A1 — mgmt durable read tools (assignment_list / report_list).
 *
 * Reads are DURABLE across Chief activations: assignments/reports written under run A
 * are returned by the read tools called under run B. assignment_list enriches each row
 * with the dispatched lead run's CURRENT status (null when undispatched). WRITES keep
 * their run-scoped ownership (pick_workflow from run B on A's assignment still throws).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb, mgmtDb } from '../src/db.js'
import { mgmtTools, MgmtError, type MgmtContext } from '../src/mcp/mgmt.js'
import { seedProfiles } from '../src/profiles.js'
import type { Assignment, MgmtReport } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_A = uuid()
const RUN_B = uuid()
const LEAD_RUN = uuid()

type AssignmentRead = Assignment & { leadRunStatus: string | null }

function call(name: string, args: unknown, ctx: MgmtContext): unknown {
  const t = mgmtTools.find(x => x.name === name)
  if (!t) throw new Error(`no such mgmt tool: ${name}`)
  return t.handler(args, ctx)
}
const ctxA: MgmtContext = { runId: RUN_A }
const ctxB: MgmtContext = { runId: RUN_B }

beforeAll(() => {
  // assign_lead resolves the lead against the durable roster now (F-067) — seed it
  // (idempotent) so Backend/Frontend/Systems/Security/Network resolve regardless of order.
  seedProfiles()
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `a1-mgmt-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/a1-mgmt',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  for (const id of [RUN_A, RUN_B]) {
    runsDb.insertRun.run({
      id, prompt: 'a1 mgmt fixture', cwd: '/tmp/a1-mgmt', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
  }
  // A terminal lead run so leadRunStatus reflects a real status.
  runsDb.insertRun.run({
    id: LEAD_RUN, prompt: 'lead run', cwd: '/tmp/a1-mgmt', worktree: null, status: 'done',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
})

afterAll(() => {
  db.prepare('DELETE FROM mgmt_reports WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM mgmt_assignments WHERE run_id IN (?, ?)').run(RUN_A, RUN_B)
  db.prepare('DELETE FROM runs WHERE id IN (?, ?, ?)').run(RUN_A, RUN_B, LEAD_RUN)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('A1 mgmt read tools', () => {
  it('assignment_list is cross-activation: run B sees run A\'s assignment', () => {
    const a = call('assign_lead', { lead: 'Backend', objective: 'cross-activation objective' }, ctxA) as Assignment
    const listed = call('assignment_list', {}, ctxB) as AssignmentRead[]
    const found = listed.find(x => x.id === a.id)
    expect(found).toBeDefined()
    expect(found!.objective).toBe('cross-activation objective')
  })

  it('leadRunStatus is null when undispatched and the lead run\'s status once set', () => {
    const a = call('assign_lead', { lead: 'Frontend', objective: 'dispatch me' }, ctxA) as Assignment

    const before = (call('assignment_list', {}, ctxB) as AssignmentRead[]).find(x => x.id === a.id)!
    expect(before.leadRunStatus).toBeNull()

    mgmtDb.setAssignmentLeadRun.run({ id: a.id, leadRunId: LEAD_RUN, updatedAt: Date.now() })

    const after = (call('assignment_list', {}, ctxB) as AssignmentRead[]).find(x => x.id === a.id)!
    expect(after.leadRunId).toBe(LEAD_RUN)
    expect(after.leadRunStatus).toBe('done')
  })

  it('report_list is cross-activation: run B sees run A\'s report; limit respected', () => {
    const r = call('report', { body: 'a1 cross-activation report' }, ctxA) as MgmtReport
    const listed = call('report_list', {}, ctxB) as MgmtReport[]
    expect(listed.some(x => x.id === r.id)).toBe(true)

    // a second report so a limit of 1 is meaningful
    call('report', { body: 'second report' }, ctxA)
    const capped = call('report_list', { limit: 1 }, ctxB) as MgmtReport[]
    expect(capped).toHaveLength(1)
  })

  it('assignment_list respects limit', () => {
    call('assign_lead', { lead: 'Systems', objective: 'lim-1' }, ctxA)
    call('assign_lead', { lead: 'Security', objective: 'lim-2' }, ctxA)
    const capped = call('assignment_list', { limit: 1 }, ctxB) as AssignmentRead[]
    expect(capped).toHaveLength(1)
  })

  it('WRITES keep run-scoped ownership: pick_workflow from run B on A\'s assignment throws', () => {
    const a = call('assign_lead', { lead: 'Network', objective: 'owned by A' }, ctxA) as Assignment
    expect(() => call('pick_workflow', { assignmentId: a.id, workflow: 'x' }, ctxB)).toThrow(MgmtError)
  })
})
