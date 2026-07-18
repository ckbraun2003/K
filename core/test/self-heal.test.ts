import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { db } from '../src/db.js'
import { getProfile, createProfile } from '../src/profiles.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'

const { startRunMock } = vi.hoisted(() => ({ startRunMock: vi.fn() }))
vi.mock('../src/supervisor.js', async () => ({
  ...(await vi.importActual('../src/supervisor.js')), startRun: startRunMock,
}))
import { onRunTerminalForHeal } from '../src/self-heal.js'
import { OPEN_PROPOSAL_CAP } from '../src/proposal-collectors.js'
import { randomUUID } from 'node:crypto'

// agent_runs.profile_id REFERENCES agent_profiles(id) (FK ON) — the seed needs 'lead-backend'
// to exist. Shared DB may already carry it; create only what is absent, remove only what we made.
let createdLeadProfile = false
beforeAll(() => {
  if (!getProfile('lead-backend')) {
    createProfile({ id: 'lead-backend', name: 'Backend', tier: 'orchestrator' })
    createdLeadProfile = true
  }
})
afterAll(() => {
  if (createdLeadProfile) db.prepare(`DELETE FROM agent_profiles WHERE id = 'lead-backend'`).run()
})

const ON = { enabled: true, proposals: false, backlogAutoPull: false, selfHeal: true, maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8 }

function seedFailedRun(id: string, retryCount = 0, stderr: string | null = 'ECONNRESET') {
  db.prepare(`INSERT INTO runs (id, prompt, cwd, worktree, status, model, retry_count, created_at) VALUES (?, 'p','.','.','error','claude-sonnet-4-6', ?, ?)`).run(id, retryCount, Date.now())
  db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at) VALUES (?, 'lead-backend', ?, 'delegation', 'g', 'failed', ?)`).run('ar-'+id, id, Date.now())
  // A run's error text is the `text` column of its type='error' event (supervisor.ts:992-996,
  // text:String(err)); real events columns are id, run_id, seq, type, ts, text (BLOCKER 4).
  // A clean non-zero exit persists NO error event → stderr null → seed skips the event.
  if (stderr != null) {
    db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'error', ?, ?)`).run('e-'+id, id, Date.now(), stderr)
  }
}

describe('self-heal', () => {
  beforeEach(() => {
    __resetConfigCache(); startRunMock.mockReset()
    // SHARED K_DATA_DIR: sibling suites leave RESTRICT-referencing children on `runs`, so a
    // blanket `DELETE FROM runs` FK-fails. Scope cleanup to THIS suite's own 'r%' rows only,
    // children before parents (events.run_id → runs has no ON DELETE = RESTRICT). `runs` form a
    // retry chain via the self-FK runs.retry_of (also RESTRICT), so delete leaf-first (rows not
    // referenced as any retry's parent) until none of ours remain.
    db.prepare(`DELETE FROM events WHERE run_id LIKE 'r%'`).run()
    db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'r%'`).run()
    db.prepare(`DELETE FROM work_items WHERE source_key LIKE 'self_heal:r%'`).run()
    let removed: number
    do {
      removed = db.prepare(
        `DELETE FROM runs WHERE id LIKE 'r%' AND id NOT IN (SELECT retry_of FROM runs WHERE retry_of IS NOT NULL)`,
      ).run().changes as number
    } while (removed > 0)
    setAutonomySettings(ON)
  })

  it('does nothing when selfHeal is off', async () => {
    setAutonomySettings({ ...ON, selfHeal: false })
    seedFailedRun('r1')
    expect(await onRunTerminalForHeal({ id: 'r1', status: 'error' } as any)).toBe('skipped')
  })

  it('retries a transient failure with a fallback and stamps lineage', async () => {
    // Real startRun inserts a runs row; the mock must too, so setRunRetry can UPDATE it.
    startRunMock.mockImplementation(async () => {
      db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES ('r1-retry','p','.','.','running',?)`).run(Date.now())
      return { id: 'r1-retry' }
    })
    seedFailedRun('r1', 0, 'ECONNRESET')
    expect(await onRunTerminalForHeal({ id: 'r1', status: 'error' } as any)).toBe('retried')
    expect(startRunMock).toHaveBeenCalledTimes(1)
    // The retry MUST inherit the original run's cwd — else startRun defaults to REPO_ROOT (K's repo)
    // and a project-scoped retry runs against the wrong codebase (SEAMS M1).
    expect(startRunMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd: '.' }))
    const retry = db.prepare(`SELECT retry_of, retry_count FROM runs WHERE id='r1-retry'`).get() as any
    expect(retry.retry_of).toBe('r1'); expect(retry.retry_count).toBe(1)
  })

  it('parks (Inbox proposal) after MAX_RETRIES or on a permanent failure', async () => {
    seedFailedRun('r2', 2, 'ECONNRESET')       // already at cap
    expect(await onRunTerminalForHeal({ id: 'r2', status: 'error' } as any)).toBe('parked')
    expect((db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source_key = 'self_heal:r2'`).get() as any).n).toBe(1)
    expect(startRunMock).not.toHaveBeenCalled()
  })

  it('parks a clean non-zero exit (no persisted stderr → unknown → not retryable)', async () => {
    seedFailedRun('r3', 0, null)               // no error event persisted
    expect(await onRunTerminalForHeal({ id: 'r3', status: 'error' } as any)).toBe('parked')
    expect((db.prepare(`SELECT failure_class FROM runs WHERE id='r3'`).get() as any).failure_class).toBe('unknown')
  })

  it('respects OPEN_PROPOSAL_CAP — a full inbox parks WITHOUT inserting (BE.7 cap-bypass fix)', async () => {
    // Fill the open-proposal population to the cap with unrelated seeded rows.
    for (let i = 0; i < OPEN_PROPOSAL_CAP; i++) {
      db.prepare(`INSERT INTO work_items (id, title, status, scope, source, source_key, created_at, updated_at)
                  VALUES (?, 't', 'blocked', 'org', 'ci_failed', ?, ?, ?)`)
        .run(randomUUID(), `shcap:${i}`, Date.now(), Date.now())
    }
    try {
      seedFailedRun('r4', 2, 'ECONNRESET') // at retry cap → park path
      expect(await onRunTerminalForHeal({ id: 'r4', status: 'error' } as any)).toBe('parked')
      expect((db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source_key = 'self_heal:r4'`).get() as any).n).toBe(0)
    } finally {
      db.prepare(`DELETE FROM work_items WHERE source_key LIKE 'shcap:%'`).run()
    }
  })

  it("skips a failed chat-turn — the session engine owns turn recovery, never a headless 'job' re-run (A.3, D-127)", async () => {
    // A session turn: owner-bearing (dispatched via startAgentRun) AND kind='chat-turn',
    // with a retryable failure class and retry headroom — everything the retry arm
    // wants EXCEPT the kind. Pre-A.3-fix this re-ran the seed as a kind='job' one-shot.
    db.prepare(`INSERT INTO runs (id, prompt, cwd, worktree, status, model, retry_count, kind, created_at) VALUES ('r6','p','.','.','error','claude-sonnet-4-6',0,'chat-turn',?)`).run(Date.now())
    db.prepare(`INSERT INTO agent_runs (id, profile_id, run_id, trigger, goal, status, created_at) VALUES ('ar-r6','lead-backend','r6','delegation','g','failed',?)`).run(Date.now())
    db.prepare(`INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, 1, 'error', ?, ?)`).run('e-r6', 'r6', Date.now(), 'ECONNRESET')

    expect(await onRunTerminalForHeal({ id: 'r6', status: 'error' } as any)).toBe('skipped')
    expect(startRunMock).not.toHaveBeenCalled()
    // Not parked either — no Inbox noise for conversation traffic.
    expect((db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source_key = 'self_heal:r6'`).get() as any).n).toBe(0)
  })

  it('re-heals a failed retry (a descended run has no agent_runs owner but is still eligible)', async () => {
    // The retry's own run row must exist so setRunRetry can stamp its lineage.
    startRunMock.mockImplementation(async () => {
      db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,created_at) VALUES ('R1-retry','p','.','.','running',?)`).run(Date.now())
      return { id: 'R1-retry' }
    })
    // R0: the original org run (agent_runs owner), retry_count 0.
    seedFailedRun('R0', 0, 'ECONNRESET')
    // R1: R0's retry — dispatched via startRun, so it has NO agent_runs row of its own; it is
    // eligible only via runs.retry_of. Without the retry_of eligibility branch this would be
    // orphaned ('skipped') and the ladder would never climb past retry_count=1.
    db.prepare(`INSERT INTO runs (id,prompt,cwd,worktree,status,model,retry_of,retry_count,created_at) VALUES ('R1','p','.','.','error','claude-sonnet-4-6','R0',1,?)`).run(Date.now())
    db.prepare(`INSERT INTO events (id,run_id,seq,type,ts,text) VALUES ('e-R1','R1',1,'error',?,'ECONNRESET')`).run(Date.now())
    const outcome = await onRunTerminalForHeal({ id: 'R1', status: 'error' } as any)
    expect(outcome).not.toBe('skipped')
    expect(outcome).toBe('retried')       // retry_count 1 < MAX_RETRIES → climbs to 2
    const retry = db.prepare(`SELECT retry_of, retry_count FROM runs WHERE id='R1-retry'`).get() as any
    expect(retry.retry_of).toBe('R1'); expect(retry.retry_count).toBe(2)
  })
})
