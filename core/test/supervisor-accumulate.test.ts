import { describe, it, expect } from 'vitest'
import { accumulate } from '../src/supervisor.js'
// parseClaudeLine is the pure parser; parseLine is the validated ingest wrapper
// (requires a uuid runId). These tests exercise parse logic, so target the parser.
import { parseClaudeLine as parseLine } from '../src/providers.js'
import type { AgentEvent } from '@k/shared'

function ev(partial: Partial<AgentEvent>): AgentEvent {
  return {
    id: 'e', runId: 'r', seq: 0, type: 'assistant', ts: 0,
    ...partial,
  }
}

describe('accumulate — sum-per-turn tokens + cost last-wins (F-057)', () => {
  // Only the per-turn `usage` event (the claude `result` line) is authoritative; its
  // tokens SUM across turns while total_cost_usd (cumulative) stays last-wins.
  const usageEv = (p: Partial<AgentEvent>): AgentEvent => ev({ type: 'usage', ...p })

  it('a free/cache-only turn (0 tokens) does NOT wipe the accumulated tokens; cost overwrites', () => {
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    usage = accumulate(usage, usageEv({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 }))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 })

    // A later 0-token turn ADDS 0 (tokens preserved — the old last-wins bug wiped them);
    // total_cost_usd is a cumulative figure, so a real 0 still overwrites (falsy-zero fix).
    usage = accumulate(usage, usageEv({ tokensIn: 0, tokensOut: 0, costUsd: 0 }))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0 })
  })

  it('preserves prior totals for a NON-usage event (streaming assistant text)', () => {
    let usage = { tokensIn: 100, tokensOut: 50, costUsd: 0.5 }
    // assistant text event — not the authoritative usage carrier → totals unchanged
    usage = accumulate(usage, ev({ text: 'hello' }))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 })
  })

  it('sums token deltas across usage events; cost tracks the latest cumulative figure', () => {
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    usage = accumulate(usage, usageEv({ tokensIn: 0, tokensOut: 0, costUsd: 0 }))
    usage = accumulate(usage, usageEv({ tokensIn: 200, tokensOut: 80, costUsd: 1.25 }))
    expect(usage).toEqual({ tokensIn: 200, tokensOut: 80, costUsd: 1.25 })
  })

  it('one-shot run (single usage event) is byte-identical to the whole-run usage — REGULAR unchanged', () => {
    // A regular dispatch run is one-shot: exactly ONE usage event, so the sum equals it.
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    usage = accumulate(usage, ev({ type: 'assistant', tokensIn: 100, tokensOut: 20 })) // streaming — ignored
    usage = accumulate(usage, usageEv({ tokensIn: 8000, tokensOut: 500, costUsd: 0.42 }))
    expect(usage).toEqual({ tokensIn: 8000, tokensOut: 500, costUsd: 0.42 })
  })

  it('multi-turn run ENDING on a compact turn does not collapse tokens_in (the F-057 bug)', () => {
    // Three turns; the last (a /compact) reports near-zero fresh input. Old last-wins
    // collapsed tokens_in to ~that last turn; summing keeps the true total.
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    const turns = [
      { tokensIn: 6000, tokensOut: 300, costUsd: 0.10 },
      { tokensIn: 9000, tokensOut: 400, costUsd: 0.24 },
      { tokensIn: 12, tokensOut: 90, costUsd: 0.25 }, // compact: near-zero fresh input
    ]
    for (const t of turns) {
      usage = accumulate(usage, ev({ type: 'assistant', tokensIn: 5, tokensOut: 1 })) // streaming noise between turns
      usage = accumulate(usage, usageEv(t))
    }
    expect(usage.tokensIn).toBe(6000 + 9000 + 12) // true total, NOT 12
    expect(usage.tokensOut).toBe(300 + 400 + 90)
    expect(usage.costUsd).toBe(0.25) // cumulative total_cost_usd → last-wins
  })
})

describe('parseLine — result event with zero cost', () => {
  it('records costUsd: 0 from total_cost_usd: 0 (free/Ollama run)', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      result: 'done',
    })
    const event = parseLine(line, 'r', 1)
    expect(event).not.toBeNull()
    expect(event!.tokensIn).toBe(0)
    expect(event!.tokensOut).toBe(0)
    expect(event!.costUsd).toBe(0)
  })

  it('a stale non-zero cost is overwritten to 0 by a zero-cost result event (tokens preserved)', () => {
    let usage = { tokensIn: 500, tokensOut: 200, costUsd: 2.0 }
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    })
    const event = parseLine(line, 'r', 1)!
    usage = accumulate(usage, event)
    // F-057: a 0-token result ADDS nothing to the summed tokens (they stay), while the
    // cumulative total_cost_usd of 0 still overwrites the stale 2.0 (falsy-zero guard).
    expect(usage).toEqual({ tokensIn: 500, tokensOut: 200, costUsd: 0 })
  })

  it('sums cumulative cache token fields from nested usage', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 3,
        output_tokens: 7,
      },
      total_cost_usd: 0.01,
    })
    const event = parseLine(line, 'r', 1)!
    expect(event.tokensIn).toBe(18)
    expect(event.tokensOut).toBe(7)
    expect(event.costUsd).toBe(0.01)
  })
})
