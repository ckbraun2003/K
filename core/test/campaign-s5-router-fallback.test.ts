/**
 * Campaign S5 — router fallback + cost-aware boundaries + provider consistency (LOCK).
 *
 * Extends `router.test.ts` / `router.config.test.ts`. The contract: ollama is
 * selected ONLY when enabled AND reachable; every uncertainty degrades to claude
 * so a routing decision can never fail a run. route() is exercised with injected
 * deps (no DB / env / live probe). We pin the cost-cap boundary arithmetic and
 * that the routed provider always resolves to a matching dispatcher (no silent
 * provider swap).
 *
 * NB: the {explicit model + maxCostUsd} combination that DOES silently swap a
 * Claude model id onto `ollama run` is a CONFIRMED FAULT, codified red in
 * regressions/s5-001-explicit-model-cost-routes-to-ollama.
 *
 * Findings: S5-015 (degradation), S5-016 (cost boundaries), S5-017 (provider
 * consistency), S5-018 (probe). See testing/findings/S5-supervisor-providers-routing.md.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { route, probeOllama, isOllamaReachable } from '../src/router.js'
import { getProvider, claudeProvider, ollamaProvider } from '../src/providers.js'

const TASK = { prompt: 'do a thing' }
const UP = { enableOllama: true, ollamaReachable: true }

describe('S5 — route degrades to claude on any uncertainty (S5-015)', () => {
  it('disabled → claude regardless of preferLocal + reachable', () => {
    expect(route({ ...TASK, preferLocal: true }, { enableOllama: false, ollamaReachable: true }).provider).toBe('claude')
  })
  it('enabled but unreachable → claude', () => {
    expect(route({ ...TASK, preferLocal: true }, { enableOllama: true, ollamaReachable: false }).provider).toBe('claude')
  })
  it('route() never throws for any combination of hints', () => {
    const matrix = [
      { preferLocal: true }, { preferLocal: false }, { maxCostUsd: 0 }, { maxCostUsd: -1 },
      { maxCostUsd: NaN }, { maxCostUsd: Infinity }, { preferLocal: true, maxCostUsd: 0.01 },
    ]
    for (const hint of matrix) {
      expect(() => route({ ...TASK, ...hint }, { ...UP, avgClaudeCostUsd: () => 0.5 })).not.toThrow()
      expect(() => route({ ...TASK, ...hint }, { enableOllama: false })).not.toThrow()
    }
  })
})

describe('S5 — cost-aware boundary arithmetic (S5-016)', () => {
  const withAvg = (avg: number | null) => ({ ...UP, avgClaudeCostUsd: () => avg })

  it('avg EXACTLY equal to cap stays on claude (strict greater-than)', () => {
    expect(route({ ...TASK, maxCostUsd: 0.5 }, withAvg(0.5)).provider).toBe('claude')
  })
  it('avg just above cap routes to ollama', () => {
    expect(route({ ...TASK, maxCostUsd: 0.5 }, withAvg(0.5001)).provider).toBe('ollama')
  })
  it('cap of 0 routes to ollama whenever any positive history exists', () => {
    expect(route({ ...TASK, maxCostUsd: 0 }, withAvg(0.0001)).provider).toBe('ollama')
  })
  it('negative cap routes to ollama (claude always "costs more" than a negative cap)', () => {
    expect(route({ ...TASK, maxCostUsd: -5 }, withAvg(0.01)).provider).toBe('ollama')
  })
  it('NaN cap degrades safely to claude (any comparison with NaN is false)', () => {
    expect(route({ ...TASK, maxCostUsd: NaN }, withAvg(1)).provider).toBe('claude')
  })
  it('no run-outcome data (null avg) stays on claude even with a tiny cap', () => {
    expect(route({ ...TASK, maxCostUsd: 0.0001 }, withAvg(null)).provider).toBe('claude')
  })
  it('preferLocal wins OVER the cost branch (explicit hint short-circuits)', () => {
    // preferLocal returns before cost is even consulted
    expect(route({ ...TASK, preferLocal: true, maxCostUsd: 999 }, withAvg(0.0001)).provider).toBe('ollama')
  })
  it('preferLocal:false with a within-cap cost stays claude', () => {
    expect(route({ ...TASK, preferLocal: false, maxCostUsd: 1.0 }, withAvg(0.5)).provider).toBe('claude')
  })
})

describe('S5 — no silent provider swap: routed name always resolves to a matching dispatcher (S5-017)', () => {
  it('a claude route carries no baseUrl and resolves to the claude provider', () => {
    const r = route(TASK, UP)
    expect(r.provider).toBe('claude')
    expect(r.baseUrl).toBeUndefined()
    expect(getProvider(r.provider)).toBe(claudeProvider)
    expect(getProvider(r.provider).binary).toBe('claude')
  })
  it('an ollama route carries a baseUrl and resolves to the ollama provider', () => {
    const r = route({ ...TASK, preferLocal: true }, UP)
    expect(r.provider).toBe('ollama')
    expect(r.baseUrl).toBeTruthy()
    expect(getProvider(r.provider)).toBe(ollamaProvider)
    expect(getProvider(r.provider).binary).toBe('ollama')
  })
  it('getProvider(name).name === name for both providers (structural invariant)', () => {
    expect(getProvider('claude').name).toBe('claude')
    expect(getProvider('ollama').name).toBe('ollama')
  })
})

describe('S5 — probeOllama never throws and sets the cached flag (S5-018)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ok response → reachable true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    expect(await probeOllama('http://localhost:11434', 50)).toBe(true)
    expect(isOllamaReachable()).toBe(true)
  })
  it('non-ok status → reachable false (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    expect(await probeOllama('http://localhost:11434', 50)).toBe(false)
    expect(isOllamaReachable()).toBe(false)
  })
  it('fetch rejection → reachable false (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await probeOllama('http://localhost:11434', 50)).toBe(false)
    expect(isOllamaReachable()).toBe(false)
  })
})
