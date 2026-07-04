/**
 * Routing metrics — pure aggregation (aggregateRouting / routingRecommendation)
 * plus an endpoint shape test for GET /api/metrics/routing.
 *
 * The endpoint test reuses the buildApp() + app.inject pattern (K_SKIP_BOOTSTRAP)
 * from skills-route.test.ts; it's read-only so no supervisor mock is needed and we
 * just assert 200 + payload shape, tolerant of whatever rows the test DB holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import { aggregateRouting, routingRecommendation, type RoutingRunRow } from '../src/metrics.js'
import { db } from '../src/db.js'

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const NOW = 1_700_000_000_000

function row(over: Partial<RoutingRunRow>): RoutingRunRow {
  return {
    provider: 'claude',
    model: 'sonnet',
    status: 'done',
    cost_usd: 0,
    created_at: NOW,
    ended_at: null,
    ...over,
  }
}

describe('aggregateRouting', () => {
  it('groups by provider+model and counts runs', () => {
    const stats = aggregateRouting(
      [
        row({ provider: 'claude', model: 'sonnet' }),
        row({ provider: 'claude', model: 'sonnet' }),
        row({ provider: 'ollama', model: 'llama3' }),
      ],
      NOW,
    )
    expect(stats.totalRuns).toBe(3)
    expect(stats.groups).toHaveLength(2)
    const sonnet = stats.groups.find(g => g.model === 'sonnet')!
    expect(sonnet.runs).toBe(2)
    expect(stats.generatedAt).toBe(NOW)
  })

  it('computes successRate as done / terminal-count, killed excluded (F-082)', () => {
    const stats = aggregateRouting(
      [
        row({ status: 'done' }),
        row({ status: 'error' }),
        row({ status: 'killed' }),    // operator kill: NEITHER success nor failure — excluded
        row({ status: 'running' }),   // non-terminal: excluded from rate denominator
      ],
      NOW,
    )
    const g = stats.groups[0]
    expect(g.runs).toBe(4)
    expect(g.terminalRuns).toBe(2)             // done + error (killed & running excluded)
    expect(g.successRate).toBeCloseTo(1 / 2, 5) // 1 done / 2 terminal
  })

  it('an operator-killed run does NOT lower the success rate (F-082)', () => {
    // Nothing actually FAILED here — two done + one operator kill. The kill must not
    // drag success below 100%.
    const stats = aggregateRouting(
      [row({ status: 'done' }), row({ status: 'done' }), row({ status: 'killed' })],
      NOW,
    )
    const g = stats.groups[0]
    expect(g.runs).toBe(3)
    expect(g.terminalRuns).toBe(2) // killed excluded from the terminal denominator
    expect(g.successRate).toBe(1)  // 2 done / 2 terminal
  })

  it('successRate is 0 when there are no terminal runs', () => {
    const stats = aggregateRouting([row({ status: 'running' }), row({ status: 'queued' })], NOW)
    expect(stats.groups[0].successRate).toBe(0)
  })

  it('a killed-only group has no terminal runs → successRate 0, terminalRuns 0', () => {
    const stats = aggregateRouting([row({ status: 'killed' }), row({ status: 'killed' })], NOW)
    const g = stats.groups[0]
    expect(g.runs).toBe(2)
    expect(g.terminalRuns).toBe(0)
    expect(g.successRate).toBe(0)
  })

  it('avgCostUsd ignores zero-cost runs; totalCostUsd sums all', () => {
    const stats = aggregateRouting(
      [
        row({ cost_usd: 0 }),
        row({ cost_usd: 0.02 }),
        row({ cost_usd: 0.04 }),
      ],
      NOW,
    )
    const g = stats.groups[0]
    expect(g.avgCostUsd).toBeCloseTo(0.03, 5) // (0.02 + 0.04) / 2
    expect(g.totalCostUsd).toBeCloseTo(0.06, 5)
  })

  it('avgCostUsd is 0 when every run is zero-cost', () => {
    const stats = aggregateRouting([row({ cost_usd: 0 }), row({ cost_usd: 0 })], NOW)
    expect(stats.groups[0].avgCostUsd).toBe(0)
  })

  it('avgLatencyMs ignores null and negative latencies', () => {
    const stats = aggregateRouting(
      [
        row({ created_at: NOW, ended_at: NOW + 1000 }),
        row({ created_at: NOW, ended_at: NOW + 3000 }),
        row({ created_at: NOW, ended_at: null }),       // ignored
        row({ created_at: NOW, ended_at: NOW - 500 }),  // negative: ignored
      ],
      NOW,
    )
    expect(stats.groups[0].avgLatencyMs).toBe(2000) // (1000 + 3000) / 2
  })

  it('avgLatencyMs is 0 when no run has a usable ended_at', () => {
    const stats = aggregateRouting([row({ ended_at: null })], NOW)
    expect(stats.groups[0].avgLatencyMs).toBe(0)
  })

  it('excludes awaiting_input parked time from latency — active processing time (F-082)', () => {
    const stats = aggregateRouting(
      [
        // wall = 10s, but 6s parked at awaiting_input → active latency = 4s
        row({ created_at: NOW, ended_at: NOW + 10_000, parked_ms: 6_000 }),
        // wall = 4s, never parked (parked_ms omitted → 0) → 4s
        row({ created_at: NOW, ended_at: NOW + 4_000 }),
      ],
      NOW,
    )
    expect(stats.groups[0].avgLatencyMs).toBe(4_000) // (4000 + 4000) / 2
    expect(stats.groups[0].latencyCount).toBe(2)
  })

  it('clamps latency to 0 when parked time exceeds wall-clock, still counted (F-082)', () => {
    const stats = aggregateRouting(
      [row({ created_at: NOW, ended_at: NOW + 1_000, parked_ms: 5_000 })],
      NOW,
    )
    expect(stats.groups[0].avgLatencyMs).toBe(0)
    expect(stats.groups[0].latencyCount).toBe(1)
  })

  it('sorts by runs desc, then provider+model asc', () => {
    const stats = aggregateRouting(
      [
        row({ provider: 'claude', model: 'opus' }),
        row({ provider: 'ollama', model: 'llama3' }),
        row({ provider: 'ollama', model: 'llama3' }),
        row({ provider: 'claude', model: 'sonnet' }),
        row({ provider: 'claude', model: 'sonnet' }),
      ],
      NOW,
    )
    // two 2-run groups (claude sonnet, ollama llama3) before the 1-run group
    expect(stats.groups.map(g => `${g.provider} ${g.model}`)).toEqual([
      'claude sonnet',
      'ollama llama3',
      'claude opus',
    ])
  })
})

describe('routingRecommendation', () => {
  function group(over: Partial<Parameters<typeof routingRecommendation>[0][number]>) {
    return {
      provider: 'claude', model: 'sonnet', runs: 20, terminalRuns: 20,
      successRate: 0.9, avgCostUsd: 0.01, totalCostUsd: 0.2, avgLatencyMs: 1000, latencyCount: 20,
      ...over,
    }
  }

  it('flags insufficient history below the run threshold', () => {
    const rec = routingRecommendation([group({ runs: 3 })])
    expect(rec).toMatch(/not enough run history/i)
  })

  it('does NOT flag insufficient history at exactly the threshold (10 runs)', () => {
    // threshold is strictly `< RECOMMEND_MIN_RUNS`, so 10 passes through to a
    // real recommendation (claude-only here → "local unused").
    const rec = routingRecommendation([group({ provider: 'claude', runs: 10 })])
    expect(rec).not.toMatch(/not enough run history/i)
  })

  it('notes local is unused when only claude data exists', () => {
    const rec = routingRecommendation([group({ provider: 'claude', runs: 20 })])
    expect(rec).toMatch(/local/i)
    expect(rec).toMatch(/unused|disabled/i)
  })

  it('recommends local when ollama matches claude on success at $0', () => {
    const rec = routingRecommendation([
      group({ provider: 'claude', model: 'sonnet', runs: 10, successRate: 0.9 }),
      group({ provider: 'ollama', model: 'llama3', runs: 10, successRate: 0.9, avgCostUsd: 0, totalCostUsd: 0 }),
    ])
    expect(rec).toMatch(/prefer it for low-risk/i)
  })

  it('keeps claude when it outperforms local by more than the margin', () => {
    const rec = routingRecommendation([
      group({ provider: 'claude', model: 'sonnet', runs: 10, successRate: 0.95 }),
      group({ provider: 'ollama', model: 'llama3', runs: 10, successRate: 0.5 }),
    ])
    expect(rec).toMatch(/claude/i)
    expect(rec).toMatch(/keep routing/i)
  })
})

describe('GET /api/metrics/routing', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    process.env.K_SKIP_BOOTSTRAP = '1'
    const { buildApp } = await import('../src/index.js')
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 + a well-shaped routing payload', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics/routing?days=30', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(typeof body.generatedAt).toBe('number')
    expect(typeof body.totalRuns).toBe('number')
    expect(typeof body.recommendation).toBe('string')
    expect(Array.isArray(body.groups)).toBe(true)
    for (const g of body.groups as Array<Record<string, unknown>>) {
      expect(typeof g.provider).toBe('string')
      expect(typeof g.model).toBe('string')
      expect(typeof g.runs).toBe('number')
      expect(typeof g.successRate).toBe('number')
      expect(typeof g.avgCostUsd).toBe('number')
      expect(typeof g.totalCostUsd).toBe('number')
      expect(typeof g.avgLatencyMs).toBe('number')
    }
  })

  it('400 on an out-of-range days query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics/routing?days=999', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })

  it('latency excludes awaiting_input parked time end-to-end (SQL LEAD) (F-082)', async () => {
    // Seed one run that parked at awaiting_input for 6s inside a 10s wall-clock life,
    // then assert the route (via the LEAD parked_ms SQL) reports 4s ACTIVE latency.
    const runId = uuid()
    const model = `park-e2e-${runId.slice(0, 8)}` // unique → find our group deterministically
    const t0 = Date.now()
    const insertEvt = db.prepare(
      `INSERT INTO events (id, run_id, seq, type, ts, text) VALUES (?, ?, ?, 'status', ?, ?)`,
    )
    try {
      db.prepare(
        `INSERT INTO runs (id, prompt, cwd, status, provider, model, cost_usd, created_at, ended_at)
         VALUES (?, 'p', '/tmp', 'done', 'claude', ?, 0, ?, ?)`,
      ).run(runId, model, t0, t0 + 10_000)
      insertEvt.run(uuid(), runId, 1, t0 + 2_000, 'awaiting_input')
      insertEvt.run(uuid(), runId, 2, t0 + 8_000, 'running') // parked 6s (t0+2s → t0+8s)
      insertEvt.run(uuid(), runId, 3, t0 + 10_000, 'done')

      const res = await app.inject({ method: 'GET', url: '/api/metrics/routing?days=30', headers: AUTH })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { groups: Array<{ model: string; runs: number; avgLatencyMs: number }> }
      const g = body.groups.find(x => x.model === model)
      expect(g).toBeDefined()
      expect(g!.runs).toBe(1)
      expect(g!.avgLatencyMs).toBe(4_000) // wall 10s − parked 6s = active 4s
    } finally {
      db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId)
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
    }
  })
})
