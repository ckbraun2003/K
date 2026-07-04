/**
 * Campaign S2 — workflow_step_set: enum, label keying, seq ordering (LOCK suite).
 *
 * workflow_step_set upserts a checklist line by (workflow_run_id, label). This
 * file pins the adversarial seq/label/enum edges NOT covered by kstore.test.ts:
 *   - the step status enum is its OWN set ('pending'|'in_progress'|'done'|
 *     'blocked'|'failed') — note 'cancelled' (a work_item status) is rejected,
 *     and the kind enum is validated;
 *   - the label is the upsert key and is CASE-SENSITIVE — 'CI' and 'ci' are two
 *     distinct steps (an agent foot-gun, documented as S2-011);
 *   - seq is monotonic MAX+1, an upsert of an existing label keeps its seq even
 *     when later labels exist, and seqs are never reused.
 *
 * Findings: S2-010 (enum validation), S2-011 (case-sensitive label), S2-012
 * (seq monotonicity under interleaved upserts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, runsDb, projectsDb, workflowRunsDb, workflowStepsDb } from '../src/db.js'
import { kStoreTools, type KStoreContext } from '../src/mcp/k-store.js'
import type { WorkflowStep } from '@k/shared'

const PROJECT_ID = uuid()
const RUN_WF = uuid()
const WF_ID = uuid()

function call(name: string, args: unknown, ctx: KStoreContext): unknown {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler(args, ctx)
}
const ctx: KStoreContext = { runId: RUN_WF }

beforeAll(() => {
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `s2-steps-${PROJECT_ID.slice(0, 8)}`, localPath: '/tmp/s2-steps',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  runsDb.insertRun.run({
    id: RUN_WF, prompt: 's2 steps fixture', cwd: '/tmp/s2-steps', worktree: null, status: 'running',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
    projectId: PROJECT_ID, createdAt: Date.now(),
  })
  workflowRunsDb.insertWorkflowRun.run({
    id: WF_ID, projectId: PROJECT_ID, runId: RUN_WF, taskIds: '[]', mode: 'combined',
    workflowId: null, status: 'running', createdAt: Date.now(), completedAt: null,
  })
})

afterAll(() => {
  db.prepare('DELETE FROM workflow_steps WHERE workflow_run_id = ?').run(WF_ID)
  db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(WF_ID)
  db.prepare('DELETE FROM runs WHERE id = ?').run(RUN_WF)
  db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
})

describe('S2-010: workflow_step_set enum validation', () => {
  it('rejects a status that is not a WorkflowStepStatus (e.g. work-item-only "cancelled")', () => {
    for (const bad of ['cancelled', 'open', 'completed', 'running']) {
      expect(() =>
        call('workflow_step_set', { label: `bad-status-${bad}`, kind: 'task', status: bad } as unknown, ctx),
      ).toThrow()
    }
  })

  it('rejects an unknown kind, accepts each valid kind', () => {
    expect(() =>
      call('workflow_step_set', { label: 'bad-kind', kind: 'bug', status: 'pending' } as unknown, ctx),
    ).toThrow()
    for (const kind of ['task', 'phase', 'review', 'ci'] as const) {
      const step = call('workflow_step_set', { label: `k-${kind}`, kind, status: 'pending' }, ctx) as WorkflowStep
      expect(step.kind).toBe(kind)
    }
  })
})

describe('S2-011: the label upsert key is case-sensitive', () => {
  it('"CI" and "ci" are two distinct checklist lines with distinct seq', () => {
    const upper = call('workflow_step_set', { label: 'CI', kind: 'ci', status: 'pending' }, ctx) as WorkflowStep
    const lower = call('workflow_step_set', { label: 'ci', kind: 'ci', status: 'pending' }, ctx) as WorkflowStep
    expect(lower.seq).not.toBe(upper.seq)
    const labels = (workflowStepsDb.listWorkflowSteps.all(WF_ID) as Array<{ label: string }>).map(s => s.label)
    expect(labels).toContain('CI')
    expect(labels).toContain('ci')
  })
})

describe('S2-012: seq is monotonic MAX+1 and never reused under interleaved upserts', () => {
  it('keeps an existing label\'s seq stable while new labels keep climbing', () => {
    // Fresh workflow_run so the seq counter starts clean for this scenario.
    const wf2 = uuid()
    const run2 = uuid()
    runsDb.insertRun.run({
      id: run2, prompt: 'seq', cwd: '/tmp/s2-steps', worktree: null, status: 'running',
      provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0, costUsd: 0,
      projectId: PROJECT_ID, createdAt: Date.now(),
    })
    workflowRunsDb.insertWorkflowRun.run({
      id: wf2, projectId: PROJECT_ID, runId: run2, taskIds: '[]', mode: 'combined',
      workflowId: null, status: 'running', createdAt: Date.now(), completedAt: null,
    })
    const ctx2: KStoreContext = { runId: run2 }
    try {
      const a = call('workflow_step_set', { label: 'A', kind: 'task', status: 'pending' }, ctx2) as WorkflowStep
      const b = call('workflow_step_set', { label: 'B', kind: 'task', status: 'pending' }, ctx2) as WorkflowStep
      const c = call('workflow_step_set', { label: 'C', kind: 'task', status: 'pending' }, ctx2) as WorkflowStep
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])

      // Re-upsert the MIDDLE label — seq stays 2, MAX is unaffected.
      const bAgain = call('workflow_step_set', { label: 'B', kind: 'task', status: 'done' }, ctx2) as WorkflowStep
      expect(bAgain.seq).toBe(2)
      expect(bAgain.status).toBe('done')

      // A brand-new label takes MAX+1 = 4 (no reuse of any prior seq).
      const d = call('workflow_step_set', { label: 'D', kind: 'ci', status: 'pending' }, ctx2) as WorkflowStep
      expect(d.seq).toBe(4)

      const ordered = (workflowStepsDb.listWorkflowSteps.all(wf2) as Array<{ label: string; seq: number }>)
      expect(ordered.map(s => s.label)).toEqual(['A', 'B', 'C', 'D'])
      expect(ordered.map(s => s.seq)).toEqual([1, 2, 3, 4])
    } finally {
      db.prepare('DELETE FROM workflow_steps WHERE workflow_run_id = ?').run(wf2)
      db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(wf2)
      db.prepare('DELETE FROM runs WHERE id = ?').run(run2)
    }
  })
})
