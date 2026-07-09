/**
 * agent-runs.ts — startAgentRun lifecycle (P5.0).
 *
 * Same pattern as workflows.test.ts: supervisor.startRun is mocked so no real
 * process spawns (but it inserts a real runs row — agent_runs.run_id has a FOREIGN
 * KEY → runs(id)). Covers: the SUCCESS path (tracking row inserted 'running', runId
 * patched, finalize→'completed' on a terminal run_update) and the DISPATCH-FAILURE
 * ROLLBACK (a startRun throw rolls the 'running' tracking row back to 'failed' and
 * re-throws — the row is never left 'running'). Isolated DB via vitest.config.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { db, agentRunsDb, agentProfilesDb } from '../src/db.js'
import { eventBus } from '../src/events.js'
import { startRun } from '../src/supervisor.js'
import { createProfile } from '../src/profiles.js'
import type { Run } from '@k/shared'

// startRun mocked to avoid spawning a real agent, but it MUST insert a real runs
// row: agent_runs.run_id has a FOREIGN KEY → runs(id).
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-ar-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'ar', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { startAgentRun, deriveAgentRunStatus } = await import('../src/agent-runs.js')

const PROFILE_ID = 'p50-ar-orch'

beforeAll(() => {
  createProfile({ id: PROFILE_ID, name: 'p50-ar-orch', tier: 'orchestrator' })
})

afterAll(() => {
  db.prepare(`DELETE FROM agent_runs WHERE profile_id = ?`).run(PROFILE_ID)
  db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-ar-run-%'`).run()
  db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(PROFILE_ID)
})

describe('deriveAgentRunStatus', () => {
  it('done → completed; any other terminal → failed', () => {
    expect(deriveAgentRunStatus('done')).toBe('completed')
    expect(deriveAgentRunStatus('error')).toBe('failed')
    expect(deriveAgentRunStatus('killed')).toBe('failed')
    expect(deriveAgentRunStatus('interrupted')).toBe('failed')
  })
})

describe('startAgentRun', () => {
  it('rejects an unknown profile before mutating anything', async () => {
    await expect(startAgentRun('p50-ar-nope', { trigger: 'event', goal: 'x' })).rejects.toThrow(/not found/)
  })

  it('rejects when neither goal nor thread is supplied', async () => {
    await expect(startAgentRun(PROFILE_ID, { trigger: 'event' })).rejects.toThrow(/goal or thread/)
  })

  it('inserts a running agent_runs row, patches runId, finalizes on terminal run_update', async () => {
    const { agentRunId, runId } = await startAgentRun(PROFILE_ID, {
      trigger: 'user-message',
      goal: 'do the thing',
    })
    expect(typeof agentRunId).toBe('string')
    expect(runId).toMatch(/^mock-ar-run-/)

    const row = agentRunsDb.getAgentRun.get(agentRunId) as Record<string, unknown>
    expect(row.status).toBe('running')
    expect(row.run_id).toBe(runId)
    expect(row.profile_id).toBe(PROFILE_ID)
    expect(row.trigger).toBe('user-message')
    expect(row.goal).toBe('do the thing')

    // Drive the live finalize path: emit a terminal run_update.
    eventBus.emitRunUpdate({ id: runId, status: 'done', tokensIn: 0, tokensOut: 0, costUsd: 0 } as Run)

    const after = agentRunsDb.getAgentRun.get(agentRunId) as { status: string; completed_at: number | null }
    expect(after.status).toBe('completed')
    expect(after.completed_at).not.toBeNull()
  })

  it('an explicit opts.model override wins over a profile defaultModel (C2 power control)', async () => {
    // A profile WITH an explicit defaultModel — the override must still win over it
    // (precedence: opts.model → profile.defaultModel → runtime claudeDefaultModel).
    const modelProfileId = 'p50-ar-model-orch'
    createProfile({ id: modelProfileId, name: modelProfileId, tier: 'orchestrator', defaultModel: 'claude-sonnet-4-6' })
    try {
      await startAgentRun(modelProfileId, {
        trigger: 'user-message',
        goal: 'model override',
        model: 'claude-opus-4-8',
      })
      expect(vi.mocked(startRun).mock.calls.at(-1)![1]).toMatchObject({ model: 'claude-opus-4-8' })

      // Without the override the profile default still applies (no regression).
      await startAgentRun(modelProfileId, { trigger: 'user-message', goal: 'profile default' })
      expect(vi.mocked(startRun).mock.calls.at(-1)![1]).toMatchObject({ model: 'claude-sonnet-4-6' })
    } finally {
      db.prepare(`DELETE FROM agent_runs WHERE profile_id = ?`).run(modelProfileId)
      db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(modelProfileId)
    }
  })

  it('E-02 (D-084): a plan_gate profile plan-gates a plain dispatch but NOT an interactive/persistent one', async () => {
    // Harden the tier default's interactive/persistentSession exemption. A plan_gate
    // profile's ON flag must reach startRun only for a plain org dispatch; an
    // interactive (stdin-alive) or persistent-session dispatch is EXEMPT (planGate x
    // those composes to the startRun one-shot throw), so planGate must resolve to
    // undefined — and the dispatch must not throw.
    const gateProfileId = 'p50-ar-gate-orch'
    createProfile({ id: gateProfileId, name: gateProfileId, tier: 'orchestrator' })
    agentProfilesDb.setProfilePlanGate.run(1, gateProfileId) // plan_gate ON
    const lastPlanGate = () => (vi.mocked(startRun).mock.calls.at(-1)![1] as { planGate?: boolean }).planGate
    try {
      // (persistent session) → EXEMPT: planGate undefined, no throw
      await expect(startAgentRun(gateProfileId, {
        trigger: 'user-message', goal: 'gated + persistent',
        persistentSession: { key: 'k', sessionId: 's', resume: false },
      })).resolves.toBeTruthy()
      expect(lastPlanGate()).toBeUndefined()

      // (interactive) → likewise EXEMPT
      await startAgentRun(gateProfileId, { trigger: 'user-message', goal: 'gated + interactive', interactive: true })
      expect(lastPlanGate()).toBeUndefined()

      // (plain org dispatch) → the ON case still applies: planGate true
      await startAgentRun(gateProfileId, { trigger: 'user-message', goal: 'gated plain' })
      expect(lastPlanGate()).toBe(true)
    } finally {
      db.prepare(`DELETE FROM agent_runs WHERE profile_id = ?`).run(gateProfileId)
      db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(gateProfileId)
    }
  })

  it('startRun throws — rolls the tracking row back to failed and re-throws (no leaked running row)', async () => {
    vi.mocked(startRun).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(startAgentRun(PROFILE_ID, { trigger: 'delegation', goal: 'boom' })).rejects.toThrow(/spawn failed/)

    // The dispatch's row is 'failed' with no runId — never left 'running'.
    const rows = agentRunsDb.listAgentRunsByProfile.all(PROFILE_ID) as {
      status: string
      run_id: string | null
      goal: string
    }[]
    const boom = rows.find(r => r.goal === 'boom')
    expect(boom?.status).toBe('failed')
    expect(boom?.run_id).toBeNull()
    expect(rows.some(r => r.status === 'running')).toBe(false)
  })
})
