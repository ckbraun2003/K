import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_AUTONOMY_SETTINGS } from '@k/shared'
import { setAutonomySettings, __resetConfigCache } from '../src/config-store.js'
import { budgetGate, budgetStatus } from '../src/budget-governor.js'
import { db } from '../src/db.js'

// The org cap is set RELATIVE to the CURRENT measured org spend, so these assertions
// are immune to runs accumulated by the other 100+ test files in the shared singleFork
// DB (budgetDb.orgSpendSince sums ALL runs — a blanket `DELETE FROM runs` would both
// pollute the under-cap check and fail the RESTRICT FKs from events/review_comments/
// verify_results/run_plans). Seeded runs carry no events, so a scoped delete is FK-safe.
const AUTONOMY_OFF = {
  enabled: false, proposals: false, backlogAutoPull: false, selfHeal: false,
  maxConcurrency: 1, budgetWarnPct: 0.8,
} as const

function seedRun(id: string, costUsd: number, createdAt: number): void {
  db.prepare(
    `INSERT INTO runs (id, prompt, cwd, worktree, status, cost_usd, created_at)
     VALUES (?, 'p', '.', '.', 'done', ?, ?)`,
  ).run(id, costUsd, createdAt)
}

let app: FastifyInstance
beforeAll(async () => {
  // Must be set BEFORE importing index.ts so the top-level start() is skipped (the
  // cold module-graph import is paid here, under the 10s hook budget, not the 5s test).
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
}, 60_000) // cold module-graph import in isolation can exceed the 10s hook default
afterAll(async () => {
  // Restore default autonomy (orgDailyBudgetUsd=null) so the cap this file set never
  // gates autonomous dispatches in later test files (shared singleFork app_config).
  setAutonomySettings({ ...DEFAULT_AUTONOMY_SETTINGS })
  __resetConfigCache()
  await app?.close()
})

describe('budget gate — measured org spend', () => {
  const SEEDED: string[] = []
  beforeEach(() => { __resetConfigCache() })
  afterEach(() => {
    for (const id of SEEDED.splice(0)) db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  })

  it('allows under the measured cap, blocks at/over it', () => {
    const baseline = budgetStatus().org.spentUsd
    setAutonomySettings({ ...AUTONOMY_OFF, orgDailyBudgetUsd: baseline + 0.5 })
    expect(budgetGate({}).allowed).toBe(true)
    const now = Date.now()
    SEEDED.push('bg-unit'); seedRun('bg-unit', 1, now)
    const g = budgetGate({ now: now + 1000 })
    expect(g.allowed).toBe(false)
    if (!g.allowed) expect(g.scope).toBe('org')
  })

  it('GET /api/budget reflects the measured spend (capped)', async () => {
    const AUTH = { authorization: `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}` }
    const baseline = budgetStatus().org.spentUsd
    setAutonomySettings({ ...AUTONOMY_OFF, orgDailyBudgetUsd: baseline + 0.5 })
    SEEDED.push('bg-route'); seedRun('bg-route', 1, Date.now())
    const res = await app.inject({ method: 'GET', url: '/api/budget', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().org.state).toBe('capped')
  })
})
