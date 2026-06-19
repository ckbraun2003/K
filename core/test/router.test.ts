/**
 * ModelRouter — cost-aware routing + graceful degradation.
 *
 * route() is exercised with injected deps so the decision logic is pure (no DB,
 * no env, no live probe). The contract: ollama is selected ONLY when enabled AND
 * reachable; otherwise (and on any uncertainty) it degrades to claude so a
 * routing decision can never fail a run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { route, probeOllama, isOllamaReachable } from '../src/router.js'

const TASK = { prompt: 'do a thing' }

describe('route — graceful degradation', () => {
  it('returns claude when ollama is disabled (even if preferLocal + reachable)', () => {
    const r = route({ ...TASK, preferLocal: true }, { enableOllama: false, ollamaReachable: true })
    expect(r.provider).toBe('claude')
    expect(r.model).toMatch(/claude/)
  })

  it('returns claude when ollama is enabled but unreachable', () => {
    const r = route({ ...TASK, preferLocal: true }, { enableOllama: true, ollamaReachable: false })
    expect(r.provider).toBe('claude')
  })
})

describe('route — provider selection when ollama is enabled + reachable', () => {
  const up = { enableOllama: true, ollamaReachable: true }

  it('routes to ollama on an explicit preferLocal hint', () => {
    const r = route({ ...TASK, preferLocal: true }, up)
    expect(r.provider).toBe('ollama')
    expect(r.baseUrl).toBeTruthy()
  })

  it('defaults to claude with no hints', () => {
    expect(route(TASK, up).provider).toBe('claude')
  })

  it('cost-aware: prefers ollama when claude historically costs more than the cap', () => {
    const r = route({ ...TASK, maxCostUsd: 0.01 }, { ...up, avgClaudeCostUsd: () => 0.5 })
    expect(r.provider).toBe('ollama')
  })

  it('cost-aware: stays on claude when historical cost is within the cap', () => {
    const r = route({ ...TASK, maxCostUsd: 1.0 }, { ...up, avgClaudeCostUsd: () => 0.5 })
    expect(r.provider).toBe('claude')
  })

  it('cost-aware: stays on claude when there is no run-outcome data', () => {
    const r = route({ ...TASK, maxCostUsd: 0.01 }, { ...up, avgClaudeCostUsd: () => null })
    expect(r.provider).toBe('claude')
  })
})

describe('probeOllama — reachability never throws', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks reachable when the endpoint responds ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    expect(await probeOllama('http://localhost:11434', 50)).toBe(true)
    expect(isOllamaReachable()).toBe(true)
  })

  it('marks unreachable (no throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await probeOllama('http://localhost:11434', 50)).toBe(false)
    expect(isOllamaReachable()).toBe(false)
  })
})
