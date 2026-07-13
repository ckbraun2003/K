import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'
import { db } from '../src/db.js'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { drainBacklog } from '../src/backlog-relay.js'

// Mock the dispatch module (hoisted + importActual — the repo ESM idiom, not vi.spyOn on
// a dynamic import) so no real run is spawned; startAgentRun is replaced by a stub.
const { startAgentRunMock } = vi.hoisted(() => ({ startAgentRunMock: vi.fn() }))
vi.mock('../src/agent-runs.js', async () => ({
  ...(await vi.importActual('../src/agent-runs.js')), startAgentRun: startAgentRunMock,
}))

const OFF = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, orgDailyBudgetUsd: null, budgetWarnPct: 0.8,
} as const

describe('backlog auto-pull', () => {
  beforeEach(() => {
    __resetConfigCache(); startAgentRunMock.mockReset()
    // FK-safe global wipe: work_items is referenced only by workflow_steps.work_item_id
    // (ON DELETE SET NULL); agent_runs has no referrers. Isolates the drain from open org
    // items / running default-orchestrator activations left by other files.
    db.prepare(`DELETE FROM work_items`).run(); db.prepare(`DELETE FROM agent_runs`).run()
    setAutonomySettings(OFF)
  })
  afterAll(() => {
    // Leave autonomy OFF so a later file's chief-wake / dispatch reads a clean default,
    // and drop the fixture run/items so the shared DB stays clean for later files.
    setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS }); __resetConfigCache()
    db.prepare(`DELETE FROM work_items`).run()
    db.prepare(`DELETE FROM runs WHERE id='r'`).run()
  })

  it('does nothing when disabled', async () => {
    db.prepare(`INSERT INTO work_items (id,title,status,scope,created_at,updated_at) VALUES ('w1','t','open','org',1,1)`).run()
    expect(await drainBacklog()).toBe(0)
    expect((db.prepare(`SELECT status FROM work_items WHERE id='w1'`).get() as any).status).toBe('open')
    expect(startAgentRunMock).not.toHaveBeenCalled()
  })

  it('claims exactly one open org item when enabled + slot + headroom', async () => {
    setAutonomySettings({ enabled: true, backlogAutoPull: true, maxConcurrency: 1 })
    // The real startAgentRun inserts a runs row; the mock returns a fake id, so seed a
    // matching run so setWorkItemRun's work_items.run_id → runs(id) FK is satisfied.
    db.prepare(`INSERT INTO runs (id, prompt, cwd, status, cost_usd, created_at) VALUES ('r','p','.','done',0,?)`).run(Date.now())
    startAgentRunMock.mockResolvedValue({ agentRunId: 'a', runId: 'r' })
    db.prepare(`INSERT INTO work_items (id,title,status,scope,created_at,updated_at) VALUES ('w1','t1','open','org',1,1)`).run()
    db.prepare(`INSERT INTO work_items (id,title,status,scope,created_at,updated_at) VALUES ('w2','t2','open','org',2,2)`).run()
    expect(await drainBacklog()).toBe(1)      // oldest first, one per drain (concurrency 1)
    expect(startAgentRunMock).toHaveBeenCalledTimes(1)
    expect((db.prepare(`SELECT status FROM work_items WHERE id='w1'`).get() as any).status).toBe('in_progress')
  })
})
