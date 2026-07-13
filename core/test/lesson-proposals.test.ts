import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { proposeLessons, MIN_FAILURES } from '../src/lesson-proposals.js'

const ON = { enabled: true, proposals: true, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }

// verify_results.run_id REFERENCES runs(id) (FK ON) — seed the parent run too.
function seedVerifyFail(runId: string, reason: string) {
  db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES (?,'p','.','.','error',?)`).run(runId, Date.now())
  db.prepare(`INSERT INTO verify_results (run_id, status, reason, commands, scope, started_at, completed_at) VALUES (?, 'fail', ?, '[]', 'project', ?, ?)`).run(runId, reason, Date.now(), Date.now())
}

describe('lesson proposals from repeated failures', () => {
  beforeEach(() => {
    __resetConfigCache()
    // Delete children (verify_results) before parent (runs); agent_memory.run_id → runs SET NULL.
    db.prepare('DELETE FROM verify_results').run()
    db.prepare('DELETE FROM runs').run()
    db.prepare('DELETE FROM agent_memory').run()
    setAutonomySettings(ON)
  })
  it('proposes exactly one lesson per signature that failed >= MIN_FAILURES, deduped', () => {
    // seed 2 verify failures with the same reason (same signature)
    for (let i = 0; i < MIN_FAILURES; i++) seedVerifyFail('r' + i, 'typecheck: TS2322')
    expect(proposeLessons()).toBe(1)
    expect(proposeLessons()).toBe(0) // deduped on second pass
    expect((db.prepare(`SELECT COUNT(*) n FROM agent_memory WHERE status='pending'`).get() as any).n).toBe(1)
  })
  it('does not propose for a single failure', () => {
    seedVerifyFail('x', 'once')
    expect(proposeLessons()).toBe(0)
  })
})
