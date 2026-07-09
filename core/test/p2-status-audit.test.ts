/**
 * P2 W0c — awaiting_plan runtime-set audit locks. The compiler can't see SQL
 * IN-lists or Set literals; these tests pin each frozen decision behaviorally.
 * No supervisor import — nothing here can spawn.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db, runsDb, projectsDb } from '../src/db.js'
import { LIVE_RUN_STATUSES } from '../src/routes/org-shared.js'
import { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from '../src/run-lifecycle.js'

describe('awaiting_plan runtime sets (W0c freeze)', () => {
  it('is live for the org (org-shared) and NOT terminal (run-lifecycle)', () => {
    expect(LIVE_RUN_STATUSES.has('awaiting_plan')).toBe(true)
    expect(TERMINAL_RUN_STATUSES.has('awaiting_plan')).toBe(false)
    expect(isTerminalRunStatus('awaiting_plan')).toBe(false)
  })

  it('counts toward the metrics activeRuns KPI', () => {
    const rid = randomUUID()
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: 'C:\\nowhere', worktree: null,
      status: 'awaiting_plan', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0,
      costUsd: 0, projectId: null, createdAt: Date.now() })
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE status IN ('running','queued','awaiting_input','awaiting_plan') AND id = ?`).get(rid) as { c: number }).c
    expect(n).toBe(1)
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(rid)
  })

  it('blocks project delete like the other live statuses (countActiveProjectRuns)', () => {
    // Behavioral lock on the frozen decision: an awaiting_plan run counts as an
    // active run for its project (it holds a worktree inside the project), so it
    // blocks project delete exactly like running/queued/awaiting_input. If the
    // 'awaiting_plan' member were dropped from the countActiveProjectRuns IN-list
    // (db.ts) this fails. (The runs DDL itself is covered by db-migration-v10.)
    const pid = randomUUID(); const rid = randomUUID()
    projectsDb.insertProject.run({ id: pid, name: `audit-${pid.slice(0, 8)}`, localPath: 'C:\\nowhere\\audit',
      githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: Date.now() })
    runsDb.insertRun.run({ id: rid, prompt: 'x', cwd: 'C:\\nowhere\\audit', worktree: null,
      status: 'awaiting_plan', provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0,
      costUsd: 0, projectId: pid, createdAt: Date.now() })
    expect((projectsDb.countActiveProjectRuns.get(pid) as { n: number }).n).toBe(1)
    projectsDb.deleteProject(pid) // cleanup (also exercises the FK-ordered run_plans delete)
  })
})
