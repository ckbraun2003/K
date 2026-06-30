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

describe('accumulate — falsy-zero guard', () => {
  it('records a real zero instead of keeping the stale prior value', () => {
    // A real run reports usage, then a cache-only / free turn reports 0.
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    usage = accumulate(usage, ev({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 }))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 })

    usage = accumulate(usage, ev({ tokensIn: 0, tokensOut: 0, costUsd: 0 }))
    expect(usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 })
  })

  it('preserves prior totals when a field is absent (undefined)', () => {
    let usage = { tokensIn: 100, tokensOut: 50, costUsd: 0.5 }
    // assistant text event with no usage fields — should not clobber totals
    usage = accumulate(usage, ev({ text: 'hello' }))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.5 })
  })

  it('rolls a zero-usage event followed by a real one to the real values', () => {
    let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    usage = accumulate(usage, ev({ tokensIn: 0, tokensOut: 0, costUsd: 0 }))
    usage = accumulate(usage, ev({ tokensIn: 200, tokensOut: 80, costUsd: 1.25 }))
    expect(usage).toEqual({ tokensIn: 200, tokensOut: 80, costUsd: 1.25 })
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

  it('a stale non-zero cost is overwritten to 0 by a zero-cost result event', () => {
    let usage = { tokensIn: 500, tokensOut: 200, costUsd: 2.0 }
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    })
    const event = parseLine(line, 'r', 1)!
    usage = accumulate(usage, event)
    expect(usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 })
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
