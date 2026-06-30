/**
 * Campaign S5 — context-token sum, ingest-boundary validation, and cost/token
 * accumulation (LOCK / characterization).
 *
 * Extends `supervisor-accumulate.test.ts` + `providers-enrich.test.ts`. Pins:
 *  - contextTokens = input + cache_creation + cache_read across partial usage.
 *  - the ingest boundary (`validateAgentEvent` / supervisor `parseLine`) DROPS a
 *    line whose usage fields are non-numeric — a malformed turn never persists a
 *    string/NaN into a numeric column.
 *  - accumulate() shows no drift / double-count across a long event stream
 *    (last-wins; a real 0 overwrites; an absent field preserves).
 *  - the documented `tokensIn` semantics flip: assistant events carry FRESH input
 *    only, while the terminal `result` event carries the FULL input sum (incl.
 *    cache), and last-wins makes that the final run figure.
 *
 * Findings: S5-011 (context sum), S5-012 (ingest drop), S5-013 (accumulation),
 * S5-014 (tokensIn semantics). See testing/findings/S5-supervisor-providers-routing.md.
 */
import { describe, it, expect } from 'vitest'
import { v4 as uuid } from 'uuid'
import { accumulate, validateAgentEvent, parseLine } from '../src/supervisor.js'
import { parseClaudeLine } from '../src/providers.js'
import type { AgentEvent } from '@k/shared'

const RID = uuid()
const ev = (p: Partial<AgentEvent>): AgentEvent => ({ id: uuid(), runId: RID, seq: 0, type: 'assistant', ts: 0, ...p })

describe('S5 — contextTokens sum over partial usage (S5-011)', () => {
  it('only cache_read present → contextTokens = cache_read, tokensIn unset', () => {
    const e = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage: { cache_read_input_tokens: 5000 } } }),
      RID, 1,
    )!
    expect(e.contextTokens).toBe(5000)
    expect(e.tokensIn).toBeUndefined() // input_tokens absent → not set
  })
  it('only cache_creation present → contextTokens = cache_creation', () => {
    const e = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [], usage: { cache_creation_input_tokens: 1200 } } }),
      RID, 1,
    )!
    expect(e.contextTokens).toBe(1200)
  })
  it('usage present but all-zero → contextTokens omitted (sum not > 0)', () => {
    const e = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      RID, 1,
    )!
    expect(e.contextTokens).toBeUndefined()
    expect(e.tokensIn).toBe(0) // a real 0 IS recorded for tokensIn
  })
})

describe('S5 — ingest boundary drops non-numeric usage (S5-012)', () => {
  const badLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: '100' } } })

  it('parseClaudeLine itself returns the raw (string-typed) event — it does not validate', () => {
    const e = parseClaudeLine(badLine, RID, 1)!
    expect(typeof e.tokensIn).toBe('string') // "100" — the raw parser is intentionally permissive
  })
  it('validateAgentEvent DROPS it (null) so no string lands in a numeric field', () => {
    const raw = parseClaudeLine(badLine, RID, 1)!
    expect(validateAgentEvent(raw, RID, 1)).toBeNull()
  })
  it('the supervisor parseLine wrapper also returns null for the bad line', () => {
    expect(parseLine(badLine, RID, 1)).toBeNull()
  })
  it('the same line with NUMERIC usage validates and passes through', () => {
    const good = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 100, output_tokens: 5 } } })
    const e = parseLine(good, RID, 1)!
    expect(e).not.toBeNull()
    expect(e.tokensIn).toBe(100)
  })
})

describe('S5 — accumulate has no drift / double-count over a long stream (S5-013)', () => {
  it('folding 200 mixed events yields the LAST usage-bearing values (no summing)', () => {
    let u = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    let lastIn = 0, lastOut = 0, lastCost = 0
    for (let i = 1; i <= 200; i++) {
      if (i % 3 === 0) {
        // text-only event: no usage fields → must preserve prior totals
        u = accumulate(u, ev({ text: `chunk ${i}` }))
      } else {
        lastIn = i * 10; lastOut = i; lastCost = i * 0.001
        u = accumulate(u, ev({ tokensIn: lastIn, tokensOut: lastOut, costUsd: lastCost }))
      }
    }
    // last-wins: totals equal the final usage-bearing event, NOT a running sum
    expect(u).toEqual({ tokensIn: lastIn, tokensOut: lastOut, costUsd: lastCost })
  })

  it('a real terminal 0 overwrites accumulated non-zero (free/Ollama turn)', () => {
    let u = { tokensIn: 5000, tokensOut: 900, costUsd: 3.14 }
    u = accumulate(u, ev({ tokensIn: 0, tokensOut: 0, costUsd: 0 }))
    expect(u).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 })
  })

  it('interleaved absent-field events never clobber the running totals', () => {
    let u = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    u = accumulate(u, ev({ tokensIn: 100, tokensOut: 40, costUsd: 0.5 }))
    u = accumulate(u, ev({ text: 'thinking' }))
    u = accumulate(u, ev({ tool: 'Bash' }))
    u = accumulate(u, ev({ contextTokens: 9000 })) // not a usage field
    expect(u).toEqual({ tokensIn: 100, tokensOut: 40, costUsd: 0.5 })
  })
})

describe('S5 — tokensIn semantics: fresh (assistant) vs full sum (result) (S5-014)', () => {
  it('assistant tokensIn is FRESH input; result tokensIn is the FULL input sum; last-wins', () => {
    const asst = parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 't' }], usage: { input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 } } }),
      RID, 1,
    )!
    expect(asst.tokensIn).toBe(100)        // fresh input only
    expect(asst.contextTokens).toBe(5100)  // full context for the indicator

    const result = parseLine(
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 }, total_cost_usd: 0.02 }),
      RID, 2,
    )!
    expect(result.tokensIn).toBe(115)      // FULL sum (input + cache_creation + cache_read)

    // Across the run, last-wins makes the final run.tokensIn the result's full sum,
    // NOT the assistant's fresh-input figure — documented + intentional.
    let u = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
    u = accumulate(u, asst)
    u = accumulate(u, result)
    expect(u.tokensIn).toBe(115)
    expect(u.costUsd).toBe(0.02)
  })
})
