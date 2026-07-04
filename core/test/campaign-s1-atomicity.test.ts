/**
 * Campaign S1 — transaction atomicity & FK-ordered cascade (LOCK / characterization).
 *
 *  - A db.transaction() that throws mid-write rolls back ALL prior writes in the
 *    batch (verified with a CHECK-constraint failure on the 2nd insert).
 *  - projectsDb.deleteProject is a single transaction that removes the project and
 *    every dependent row (events, runs, reports, github_cache, tasks, workflow_runs,
 *    project_graphs) atomically.
 *  - events.run_id is a NO-ACTION FK: deleting a run that still has events throws —
 *    this is exactly why deleteProject deletes events BEFORE runs.
 *
 * Findings: S1-008 (transaction rollback), S1-009 (deleteProject atomic cascade),
 * S1-010 (events.run_id NO-ACTION FK ordering).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import {
  db, runsDb, eventsDb, projectsDb, verificationDb, projectWorkItemsDb,
  workflowRunsDb, projectGraphsDb, workItemsDb,
} from '../src/db.js'

const strayWorkItemIds: string[] = []
const strayRunIds: string[] = []

afterAll(() => {
  for (const id of strayWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
  for (const id of strayRunIds) {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
})

describe('S1 — db.transaction rolls back on a mid-batch throw', () => {
  it('a CHECK violation on the 2nd insert reverts the 1st (all-or-nothing)', () => {
    const a = uuid()
    const b = uuid()
    strayWorkItemIds.push(a, b)
    const now = Date.now()
    const tx = db.transaction(() => {
      workItemsDb.insertWorkItem.run({
        id: a, runId: null, title: 'ok', body: null, status: 'open', scope: 'personal', createdAt: now, updatedAt: now,
      })
      // status not in the CHECK enum → throws, aborting the transaction.
      workItemsDb.insertWorkItem.run({
        id: b, runId: null, title: 'bad', body: null, status: 'NOPE', scope: 'personal', createdAt: now, updatedAt: now,
      })
    })
    expect(() => tx()).toThrow(/CHECK constraint/i)
    // Neither row survived — the first insert was rolled back with the failed batch.
    expect(workItemsDb.getWorkItem.get(a)).toBeUndefined()
    expect(workItemsDb.getWorkItem.get(b)).toBeUndefined()
  })
})

describe('S1 — projectsDb.deleteProject removes the project + all dependents atomically', () => {
  it('one call clears events, runs, reports, github_cache, tasks, workflow_runs, graph', () => {
    const now = Date.now()
    const projectId = uuid()
    projectsDb.insertProject.run({
      id: projectId, name: 'del-' + projectId, localPath: '/tmp/' + projectId,
      githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: now,
    })

    const runId = uuid()
    runsDb.insertRun.run({
      id: runId, prompt: 'p', cwd: '/tmp', worktree: null, status: 'done', provider: 'claude',
      model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId, createdAt: now,
    })
    eventsDb.insertEvent.run({
      id: uuid(), runId, seq: 1, type: 'status', ts: now, raw: null, text: 'e', tool: null,
      tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null, toolKind: null,
      toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null,
      childLabel: null, contextTokens: null,
    })
    verificationDb.insertVerificationReport.run({
      id: uuid(), projectId, score: 80, findings: '[]', fixesApplied: '[]',
      startedAt: now, completedAt: now, scoreBreakdown: null, coveragePct: null,
    })
    projectWorkItemsDb.insertProjectTask.run({
      id: uuid(), projectId, title: 'task', status: 'open', createdAt: now, completedAt: null,
      issueNumber: null, issueUrl: null, issueState: null,
    })
    workflowRunsDb.insertWorkflowRun.run({
      id: uuid(), projectId, runId, taskIds: '[]', mode: 'combined', workflowId: null, status: 'running',
      createdAt: now, completedAt: null,
    })
    projectGraphsDb.upsertProjectGraph.run({
      projectId, status: 'ready', builtAt: now, lastCommit: 'abc', nodeCount: 1, edgeCount: 0,
      error: null, updatedAt: now,
    })

    projectsDb.deleteProject(projectId)

    const count = (sql: string, ...args: unknown[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n
    expect(projectsDb.getProject.get(projectId)).toBeUndefined()
    expect(count('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?', projectId)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM events WHERE run_id = ?', runId)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM verification_reports WHERE project_id = ?', projectId)).toBe(0)
    // project_tasks was dropped in P5.1d2b — the work_items count below pins the
    // same cascade intent (project tasks live in work_items scope='project' now).
    expect(count('SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?', projectId)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM workflow_runs WHERE project_id = ?', projectId)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM project_graphs WHERE project_id = ?', projectId)).toBe(0)
  })
})

describe('S1 — events.run_id is a NO-ACTION FK (delete ordering matters)', () => {
  it('deleting a run that still has events throws FOREIGN KEY (events must go first)', () => {
    const runId = uuid()
    strayRunIds.push(runId)
    runsDb.insertRun.run({
      id: runId, prompt: 'p', cwd: '/tmp', worktree: null, status: 'done', provider: 'claude',
      model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, projectId: null, createdAt: Date.now(),
    })
    eventsDb.insertEvent.run({
      id: uuid(), runId, seq: 1, type: 'status', ts: Date.now(), raw: null, text: 'e', tool: null,
      tokensIn: null, tokensOut: null, costUsd: null, toolUseId: null, toolKind: null,
      toolInput: null, toolResult: null, toolResultIsError: null, subagentType: null,
      childLabel: null, contextTokens: null,
    })
    expect(() => db.prepare('DELETE FROM runs WHERE id = ?').run(runId)).toThrow(/FOREIGN KEY/i)
  })
})
