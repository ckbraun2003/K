/**
 * E-17 budget-cap 429 REGRESSION (A2's core deliverable had no automated test).
 *
 * Proves the always-on measured budget cap turns a would-be dispatch into a clean 429
 * at BOTH gated entry points, and that clearing the cap re-opens them:
 *   - POST /api/runs           — a manual dispatch (routes/runs.ts gates before startRun);
 *   - POST /api/k/ask (chief)  — an operator→Chief delegation (k-thread.ts::delegateToChief
 *                                 → startAgentRun gates 'delegation' → BudgetCapError →
 *                                 routes/k.ts maps it to 429, never an opaque 500).
 *
 * supervisor.startRun is MOCKED (inserts a real runs row, spawns no agent) so the UNCAPPED
 * sanity paths return 201 without launching an agent. The org cap is set RELATIVE to the
 * CURRENT measured org spend (immune to runs the other shared-DB test files accumulated);
 * seeded runs carry no child rows, so a SCOPED delete of their ids is FK-safe (a blanket
 * DELETE FROM runs would FK-fail against events/verify_results/run_plans/…).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { budgetStatus } from '../src/budget-governor.js'
import { db } from '../src/db.js'
import { seedProfiles } from '../src/profiles.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-bg429-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, cost_usd, created_at)
         VALUES (?, 'bg429', '.', 'queued', 0, ?)`,
      ).run(id, Date.now())
      return { id }
    }),
  }
})

const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
const AUTONOMY_OFF = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, budgetWarnPct: 0.8,
} as const

const SEEDED: string[] = []
function seedRun(id: string, costUsd: number, createdAt: number): void {
  SEEDED.push(id)
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, worktree, status, cost_usd, created_at)
     VALUES (?, 'p', '.', '.', 'done', ?, ?)`,
  ).run(id, costUsd, createdAt)
}

let app: FastifyInstance
let kThreadId: string

beforeAll(async () => {
  // Set BEFORE importing index.ts so the top-level start() bootstrap is skipped.
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
  // buildApp with bootstrap skipped does NOT seed profiles; the operator→Chief
  // delegation activates the 'chief' profile, so stand up the durable org (idempotent).
  seedProfiles()
  // A dedicated K thread for the delegation ask (turns cascade on delete in afterAll).
  const res = await app.inject({ method: 'POST', url: '/api/k/threads', headers: AUTH })
  kThreadId = res.json().id

  // Cap the org just ABOVE its current measured spend, then push a run OVER it.
  const baseline = budgetStatus().org.spentUsd
  setAutonomySettings({ ...AUTONOMY_OFF, orgDailyBudgetUsd: baseline + 0.5 })
  __resetConfigCache()
  seedRun('bg429-over', 1, Date.now()) // baseline + 1 > baseline + 0.5 → capped
}, 60_000)

afterAll(async () => {
  for (const id of SEEDED.splice(0)) { try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ } }
  try { db.prepare(`DELETE FROM agent_runs WHERE runId LIKE 'mock-bg429-run-%'`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-bg429-run-%'`).run() } catch { /* ignore */ }
  try { db.prepare('DELETE FROM k_thread_turns WHERE thread_id = ?').run(kThreadId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM k_threads WHERE id = ?').run(kThreadId) } catch { /* ignore */ }
  // Restore default autonomy (orgDailyBudgetUsd=null) so the cap this file set never
  // gates dispatches in later shared-DB test files.
  setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
  __resetConfigCache()
  await app?.close()
})

describe('budget cap → 429 at the gated dispatch entry points', () => {
  it('sanity: the org is actually capped', () => {
    __resetConfigCache()
    expect(budgetStatus().org.state).toBe('capped')
  })

  it('POST /api/runs (manual dispatch) → 429 when the org is capped', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/runs', headers: AUTH,
      payload: { prompt: 'do a thing' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().scope).toBe('org')
  })

  it('POST /api/k/ask (operator→Chief delegation) → 429 when the org is capped', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      // forceRoute 'chief' escalates → delegateToChief → startAgentRun('chief',
      // {trigger:'delegation'}) → BudgetCapError → routes/k.ts maps to 429.
      payload: { message: 'refactor the payment module', forceRoute: 'chief', threadId: kThreadId },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().scope).toBe('org')
  })

  it('clearing the cap re-opens the SAME requests (no longer 429)', async () => {
    setAutonomySettings({ orgDailyBudgetUsd: null })
    __resetConfigCache()
    expect(budgetStatus().org.state).toBe('ok')

    const manual = await app.inject({
      method: 'POST', url: '/api/runs', headers: AUTH,
      payload: { prompt: 'do a thing' },
    })
    expect(manual.statusCode).toBe(201)

    const ask = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'refactor the payment module', forceRoute: 'chief', threadId: kThreadId },
    })
    expect(ask.statusCode).not.toBe(429)
    expect(ask.statusCode).toBe(201)
  })
})
