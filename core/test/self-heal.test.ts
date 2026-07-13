import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { db } from '../src/db.js'
import { getProfile, createProfile } from '../src/profiles.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'

const { startRunMock } = vi.hoisted(() => ({ startRunMock: vi.fn() }))
vi.mock('../src/supervisor.js', async () => ({
  ...(await vi.importActual('../src/supervisor.js')), startRun: startRunMock,
}))
import { onRunTerminalForHeal } from '../src/self-heal.js'

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
    // Delete children before parents (foreign_keys=ON; events.run_id → runs(id) has no ON DELETE).
    db.prepare('DELETE FROM events').run(); db.prepare('DELETE FROM agent_runs').run()
    db.prepare('DELETE FROM runs').run(); db.prepare('DELETE FROM work_items').run()
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
})
