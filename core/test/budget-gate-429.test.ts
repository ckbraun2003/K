/**
 * E-17 budget-cap 429 REGRESSION (A2's core deliverable had no automated test).
 *
 * Proves the always-on measured budget cap turns a would-be MANUAL dispatch into a
 * clean 429 (POST /api/runs — routes/runs.ts gates before startRun), that clearing
 * the cap re-opens it, AND (A.4, D-126) that a FORCED-route K ask is NOT gated at
 * all: a forced route queues an agent_messages mailbox row — a free write, no
 * dispatch — so it returns 201 even while the org is capped. (The old
 * operator→Chief delegateToChief 429 path is retired; routes/k.ts's BudgetCapError
 * → 429 mapping survives as a dead-belt.)
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
  try { db.prepare(`DELETE FROM agent_runs WHERE run_id LIKE 'mock-bg429-run-%'`).run() } catch { /* ignore */ }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-bg429-run-%'`).run() } catch { /* ignore */ }
  try { db.prepare('DELETE FROM agent_sessions WHERE thread_id = ?').run(kThreadId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM k_thread_turns WHERE thread_id = ?').run(kThreadId) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM k_threads WHERE id = ?').run(kThreadId) } catch { /* ignore */ }
  // A.4: the forced-route asks queued mailbox rows — remove exactly ours (by body).
  try { db.prepare(`DELETE FROM agent_messages WHERE body = 'refactor the payment module'`).run() } catch { /* ignore */ }
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

  it('POST /api/k/ask (forced route) queues even when capped — a mailbox write is free, 201 not 429 (A.4)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      // A.4 (D-126): forceRoute 'chief' no longer dispatches the Chief — it queues
      // an agent_messages row for the chief profile. No dispatch → the budget gate
      // never fires → 201 with the queued shape (runId null + messageId).
      payload: { message: 'refactor the payment module', forceRoute: 'chief', threadId: kThreadId },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { runId: string | null; messageId?: string }
    expect(body.runId).toBeNull()
    expect(typeof body.messageId).toBe('string')
    const row = db.prepare('SELECT to_profile_id, status FROM agent_messages WHERE id = ?')
      .get(body.messageId!) as { to_profile_id: string; status: string } | undefined
    expect(row).toMatchObject({ to_profile_id: 'chief', status: 'queued' })
  })

  it('POST /api/k/ask (UNFORCED) dispatches even when capped — chat turns are kind-exempt end-to-end (A.3 x A.4)', async () => {
    __resetConfigCache()
    expect(budgetStatus().org.state).toBe('capped')
    // The unforced ask rides the session engine → startAgentRun with a chat-turn
    // kind (persistentSession-inferred, A.3) — structurally EXEMPT from the budget
    // gate: the operator must always reach K, capped or not.
    const res = await app.inject({
      method: 'POST', url: '/api/k/ask', headers: AUTH,
      payload: { message: 'status check while capped', threadId: kThreadId },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().runId).toMatch(/^mock-bg429-run-/)
  })

  it('clearing the cap re-opens the MANUAL dispatch (no longer 429); the forced ask stays 201', async () => {
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
