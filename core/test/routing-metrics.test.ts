/**
 * Routing metrics — pure aggregation (aggregateRouting / routingRecommendation)
 * plus an endpoint shape test for GET /api/metrics/routing.
 *
 * The endpoint test reuses the buildApp() + app.inject pattern (K_SKIP_BOOTSTRAP)
 * from skills-route.test.ts; it's read-only so no supervisor mock is needed and we
 * just assert 200 + payload shape, tolerant of whatever rows the test DB holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { aggregateRouting, routingRecommendation, type RoutingRunRow } from '../src/metrics.js'

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

  it('computes successRate as done / terminal-count', () => {
    const stats = aggregateRouting(
      [
        row({ status: 'done' }),
        row({ status: 'error' }),
        row({ status: 'killed' }),
        row({ status: 'running' }), // non-terminal: excluded from rate denominator
      ],
      NOW,
    )
    const g = stats.groups[0]
    expect(g.runs).toBe(4)
    expect(g.successRate).toBeCloseTo(1 / 3, 5) // 1 done / 3 terminal
  })

  it('successRate is 0 when there are no terminal runs', () => {
    const stats = aggregateRouting([row({ status: 'running' }), row({ status: 'queued' })], NOW)
    expect(stats.groups[0].successRate).toBe(0)
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
      provider: 'claude', model: 'sonnet', runs: 20,
      successRate: 0.9, avgCostUsd: 0.01, totalCostUsd: 0.2, avgLatencyMs: 1000,
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
})
