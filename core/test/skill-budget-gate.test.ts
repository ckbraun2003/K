/**
 * E-17 (e17 fix) — AUTONOMOUS scheduled/event SKILL runs are budget-gated.
 *
 * The budget gate rides startAgentRun + manual /api/runs, but an autonomous scheduled/
 * event skill dispatches via startRun DIRECTLY (skills.ts) and previously BYPASSED the
 * gate — so an org over its measured cap kept firing routines. startEventListener now
 * consults budgetGate before each dispatch and SKIPS (no throw) when capped; the cron
 * scheduler tick shares the identical gate.
 *
 * This drives the EVENT site deterministically: register an enabled event skill, cap
 * the org, call startEventListener() ONCE, and emit a matching run update — asserting
 * the MOCKED startRun is NOT called (dispatch skipped). Clearing the cap re-opens it.
 * supervisor.startRun is mocked (hoisted vi.mock + importActual — the repo idiom) so no
 * agent spawns; the REAL budgetGate decides. Org cap is set RELATIVE to current measured
 * spend (shared-DB-safe); seed ids are scoped for FK-safe cleanup.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import { DEFAULT_AUTONOMY_SETTINGS, type Run } from '@k/shared'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { budgetStatus } from '../src/budget-governor.js'
import { db } from '../src/db.js'
import { eventBus } from '../src/events.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-sbg-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, cost_usd, created_at)
         VALUES (?, 'sbg', '.', 'queued', 0, ?)`,
      ).run(id, Date.now())
      return { id }
    }),
  }
})

const { startRun } = await import('../src/supervisor.js')
const { startEventListener, registerSkill } = await import('../src/skills.js')

const AUTONOMY_OFF = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, budgetWarnPct: 0.8,
} as const

// The event skill fires when a run reaches this status (eventTrigger === r.status).
const TRIGGER_STATUS = 'done'
const SKILL_NAME = `sbg-event-skill-${uuid().slice(0, 8)}`
const SEEDED: string[] = []

function seedRun(id: string, costUsd: number, createdAt: number): void {
  SEEDED.push(id)
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, worktree, status, cost_usd, created_at)
     VALUES (?, 'p', '.', '.', 'done', ?, ?)`,
  ).run(id, costUsd, createdAt)
}

/** Emit a synthetic terminal run update so the event listener evaluates its skills. */
function emitDone(): void {
  eventBus.emitRunUpdate({
    id: `sbg-emit-${uuid().slice(0, 8)}`, prompt: 'x', cwd: '.', worktree: '.',
    status: TRIGGER_STATUS, provider: 'claude', model: 'm',
    tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now(), endedAt: Date.now(),
  } as Run)
}

const flush = () => new Promise(res => setTimeout(res, 0))

beforeAll(() => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  registerSkill({
    name: SKILL_NAME, type: 'workflow', source: 'do the routine',
    triggerType: 'event', eventTrigger: TRIGGER_STATUS,
  })
  // Subscribe the (now budget-gated) event listener exactly ONCE.
  startEventListener()
})

afterAll(() => {
  try { db.prepare(`DELETE FROM skill_runs WHERE skillId IN (SELECT id FROM skills WHERE name = ?)`).run(SKILL_NAME) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM skills WHERE name = ?').run(SKILL_NAME) } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-sbg-run-%'`).run() } catch { /* ignore */ }
  for (const id of SEEDED.splice(0)) { try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ } }
  setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
  __resetConfigCache()
})

describe('autonomous event-skill dispatch is budget-gated', () => {
  it('SKIPS the dispatch (startRun NOT called) when the org is capped', async () => {
    const baseline = budgetStatus().org.spentUsd
    setAutonomySettings({ ...AUTONOMY_OFF, orgDailyBudgetUsd: baseline + 0.5 })
    __resetConfigCache()
    seedRun('sbg-cap-over', 1, Date.now()) // baseline + 1 > cap → capped
    expect(budgetStatus().org.state).toBe('capped')

    const before = vi.mocked(startRun).mock.calls.length
    emitDone()
    await flush()
    // The gate short-circuited BEFORE triggerSkill → startRun, so no new dispatch.
    expect(vi.mocked(startRun).mock.calls.length).toBe(before)
  })

  it('dispatches (startRun called) once the cap is cleared', async () => {
    setAutonomySettings({ orgDailyBudgetUsd: null })
    __resetConfigCache()
    expect(budgetStatus().org.state).toBe('ok')

    const before = vi.mocked(startRun).mock.calls.length
    emitDone()
    await flush()
    // Uncapped → the same autonomous event trigger now reaches startRun.
    expect(vi.mocked(startRun).mock.calls.length).toBeGreaterThan(before)
  })
})
