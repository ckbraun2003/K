import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { proposeLessons, MIN_FAILURES } from '../src/lesson-proposals.js'

const ON = { enabled: true, proposals: true, backlogAutoPull: false, selfHeal: false, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }

// verify_results.run_id REFERENCES runs(id) (FK ON) — seed the parent run too. All seeded
// runs use a distinctive 'lp' id namespace so this suite's scoped cleanup never overlaps a
// sibling's ids (e.g. self-heal's 'r%') under the shared K_DATA_DIR gate.
function seedVerifyFail(runId: string, reason: string) {
  db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES (?,'p','.','.','error',?)`).run(runId, Date.now())
  db.prepare(`INSERT INTO verify_results (run_id, status, reason, commands, scope, started_at, completed_at) VALUES (?, 'fail', ?, '[]', 'project', ?, ?)`).run(runId, reason, Date.now(), Date.now())
}

describe('lesson proposals from repeated failures', () => {
  beforeEach(() => {
    __resetConfigCache()
    // SHARED K_DATA_DIR: a blanket `DELETE FROM runs` FK-fails on sibling suites' RESTRICT
    // children. Scope to THIS suite's own rows: verify_results (child) before runs (parent),
    // and its own fleet-wide lessons (proposeLessons writes agent_memory with run_id = NULL).
    db.prepare(`DELETE FROM verify_results WHERE run_id LIKE 'lp%'`).run()
    db.prepare(`DELETE FROM agent_memory WHERE run_id IS NULL`).run()
    db.prepare(`DELETE FROM runs WHERE id LIKE 'lp%'`).run()
    setAutonomySettings(ON)
  })
  it('proposes exactly one lesson per signature that failed >= MIN_FAILURES, deduped', () => {
    // seed 2 verify failures with the same reason (same signature)
    for (let i = 0; i < MIN_FAILURES; i++) seedVerifyFail('lp' + i, 'typecheck: TS2322')
    expect(proposeLessons()).toBe(1)
    expect(proposeLessons()).toBe(0) // deduped on second pass
    expect((db.prepare(`SELECT COUNT(*) n FROM agent_memory WHERE status='pending'`).get() as any).n).toBe(1)
  })
  it('does not propose for a single failure', () => {
    seedVerifyFail('lpx', 'once')
    expect(proposeLessons()).toBe(0)
  })
  it('dedups on the exact signature, not on LIKE wildcards carried in it', () => {
    // Signature B has no wildcard; signature A embeds a literal '%'. Seed B first so it is
    // proposed first; without the ESCAPE clause, A's '%' would wildcard-match B's already-stored
    // lesson and A would be wrongly suppressed. Two DISTINCT recurring signatures → both propose.
    for (let i = 0; i < MIN_FAILURES; i++) seedVerifyFail('lpb' + i, 'coverage 50X below bar') // sig: coverage #x below bar
    for (let i = 0; i < MIN_FAILURES; i++) seedVerifyFail('lpa' + i, 'coverage 50% below bar') // sig: coverage #% below bar
    expect(proposeLessons()).toBe(2)
    expect((db.prepare(`SELECT COUNT(*) n FROM agent_memory WHERE status='pending'`).get() as any).n).toBe(2)
  })
  it('does not re-propose a signature an operator already rejected', () => {
    for (let i = 0; i < MIN_FAILURES; i++) seedVerifyFail('lpj' + i, 'flaky auth handshake')
    expect(proposeLessons()).toBe(1)
    // Operator rejects the pending lesson.
    db.prepare(`UPDATE agent_memory SET status='rejected' WHERE status='pending'`).run()
    // Next hourly pass: the rejected signature must NOT come back as a fresh pending lesson.
    expect(proposeLessons()).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) n FROM agent_memory WHERE status='pending'`).get() as any).n).toBe(0)
  })
})
