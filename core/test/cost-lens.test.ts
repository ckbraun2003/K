/**
 * P3 C1 — measured cost roll-ups + recent-actuals. Pure read over seeded runs:
 * project/day buckets sum cost_usd; recent-actuals fall back profile→project→global
 * at n<5 and report null stats when the pool is empty. No price×token math anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db, runsDb, projectsDb } from '../src/db.js'
import type { CostRollup, RecentActuals } from '@k/shared'

vi.hoisted(() => { process.env.K_SKIP_BOOTSTRAP = '1' })
const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
let app: FastifyInstance
const projA = randomUUID(), projB = randomUUID()
const profX = randomUUID(), profY = randomUUID()   // agent profiles for the profile-scope tests
const seeded: string[] = []
const now = Date.now()

function seedRun(projectId: string | null, costUsd: number, ageDays: number): string {
  const id = randomUUID(); seeded.push(id)
  runsDb.insertRun.run({ id, prompt: 'r', cwd: 'C:\\nowhere', worktree: null, status: 'done',
    provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd, projectId,
    createdAt: now - ageDays * 86_400_000 })
  return id
}

// READ-FIRST: confirm the profile + agent_runs insert shapes in core/src/db.ts.
// The recent-actuals profile pool only needs agent_runs rows with (run_id, profile_id);
// use the exported helpers if present (agentProfilesDb.insertProfile / an agent_runs
// insert) else raw SQL matching the CREATE TABLEs. tier must be a valid enum value.
function seedProfile(id: string, name: string) {
  db.prepare(`INSERT INTO agent_profiles (id, name, tier, charter, default_model, allowed_tools, mcp_servers, skills, created_at)
              VALUES (?, ?, 'orchestrator', 'orchestrator', '', '[]', '[]', '[]', ?)`).run(id, name, now)
}
function linkRunToProfile(runId: string, profileId: string) {
  db.prepare(`INSERT INTO agent_runs (id, run_id, profile_id, trigger, created_at) VALUES (?, ?, ?, 'delegation', ?)`)
    .run(randomUUID(), runId, profileId, now)
}

beforeAll(async () => {
  const { buildApp } = await import('../src/index.js')
  app = await buildApp(); await app.ready()
  projectsDb.insertProject.run({ id: projA, name: `cl-A-${projA.slice(0, 6)}`, localPath: 'C:\\nowhere\\a',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: now })
  projectsDb.insertProject.run({ id: projB, name: `cl-B-${projB.slice(0, 6)}`, localPath: 'C:\\nowhere\\b',
    githubRemote: null, workspaceManaged: 0, bibleDir: 'artifacts/bible', createdAt: now })
  seedProfile(profX, `px-${profX.slice(0, 6)}`)
  seedProfile(profY, `py-${profY.slice(0, 6)}`)
  // projA: 6 recent runs (costs 0.001..0.006), all within 30d. Link the first 5 to profX.
  const aRuns: string[] = []
  for (let i = 1; i <= 6; i++) aRuns.push(seedRun(projA, i * 0.001, 1))
  for (let i = 0; i < 5; i++) linkRunToProfile(aRuns[i], profX)      // profX: n=5 (>= MIN_SAMPLE)
  // projB: 2 recent runs. Link both to profY (n=2 < MIN_SAMPLE → forces fallback).
  const b1 = seedRun(projB, 0.05, 2), b2 = seedRun(projB, 0.07, 3)
  linkRunToProfile(b1, profY); linkRunToProfile(b2, profY)
})
afterAll(async () => {
  for (const id of seeded) {
    db.prepare('DELETE FROM agent_runs WHERE run_id = ?').run(id)
    db.prepare('DELETE FROM runs WHERE id = ?').run(id)
  }
  db.prepare('DELETE FROM agent_profiles WHERE id IN (?, ?)').run(profX, profY)
  db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(projA, projB)
  await app.close()
})

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url, headers: AUTH })
  expect(res.statusCode).toBe(200)
  return res.json() as T
}

describe('GET /api/metrics/cost-rollup', () => {
  it('buckets measured cost by project', async () => {
    const r = await get<CostRollup>('/api/metrics/cost-rollup?days=30&groupBy=project')
    expect(r.groupBy).toBe('project')
    const a = r.buckets.find(b => b.key === projA)!
    expect(a.runs).toBe(6)
    expect(a.costUsd).toBeCloseTo(0.021) // 0.001+..+0.006
    expect(r.totalCostUsd).toBeCloseTo(r.buckets.reduce((s, b) => s + b.costUsd, 0))
  })
  it('supports day grouping', async () => {
    const r = await get<CostRollup>('/api/metrics/cost-rollup?days=30&groupBy=day')
    expect(r.groupBy).toBe('day')
    expect(r.buckets.length).toBeGreaterThanOrEqual(1)
  })
})

describe('GET /api/metrics/recent-actuals', () => {
  it('PROFILE scope when the agent has >= 5 recent runs (median/p90 via percentile 0.5/0.9)', async () => {
    const r = await get<RecentActuals>(`/api/metrics/recent-actuals?profileId=${profX}`)
    expect(r.scope).toBe('profile')
    expect(r.n).toBe(5)                                  // profX linked to 5 runs (0.001..0.005)
    expect(r.medianCostUsd).toBeCloseTo(0.003)          // percentile([.001..005], 0.5) = middle = .003
    expect(r.p90CostUsd).toBeCloseTo(0.0046)            // percentile([.001..005], 0.9): rank 3.6 → .004+.001*.6
  })
  it('falls back PROFILE → PROJECT when the agent has < 5 but the project has >= 5', async () => {
    const r = await get<RecentActuals>(`/api/metrics/recent-actuals?profileId=${profY}&projectId=${projA}`)
    expect(r.scope).toBe('project')                     // profY n=2 < 5 → projA n=6 >= 5
    expect(r.n).toBe(6)
    expect(r.medianCostUsd).toBeCloseTo(0.0035)         // percentile([.001..006], 0.5): rank 2.5 → .0035
    expect(r.p90CostUsd!).toBeGreaterThan(r.medianCostUsd!)
  })
  it('falls back PROJECT → GLOBAL when the project has < 5 recent runs', async () => {
    const r = await get<RecentActuals>(`/api/metrics/recent-actuals?projectId=${projB}`)
    expect(r.scope).toBe('global')                      // projB n=2 < 5 → global
    // GLOBAL scope is DB-wide (not entity-filtered), so under the shared singleFork DB
    // other files' residue may inflate n — assert the floor + a real median, not an exact n.
    expect(r.n).toBeGreaterThanOrEqual(8)               // >= the 8 seeded positive-cost runs
    expect(r.medianCostUsd).toBeGreaterThan(0)
  })
})
