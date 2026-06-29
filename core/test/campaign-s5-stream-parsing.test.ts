/**
 * Campaign S5 — stream-json parsing tolerance (LOCK / characterization).
 *
 * The supervisor feeds every NDJSON line from `claude`/`ollama` straight into a
 * provider parser. The hard invariant is: a malformed / partial / truncated /
 * interleaved / scalar line must NEVER throw — it degrades to `null` (claude) or
 * a plain assistant event (ollama). These tests pin that the parsers stay
 * defensive and that `mapType` + the `result` fallback chain behave exactly.
 *
 * Extends `providers.test.ts` / `providers-enrich.test.ts` (which cover the happy
 * shapes); here we hammer the malformed / fallback / scalar vectors.
 *
 * Findings: S5-005 (never-throw), S5-006 (mapType), S5-007 (result fallbacks),
 * S5-008 (ollama parse). See testing/findings/S5-supervisor-providers-routing.md.
 */
import { describe, it, expect } from 'vitest'
import { parseClaudeLine, parseOllamaLine } from '../src/providers.js'

const RID = '00000000-0000-0000-0000-000000000000'
const CTX = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
const pc = (line: string) => parseClaudeLine(line, RID, 1, CTX)

describe('S5 — parseClaudeLine never throws on hostile input (S5-005)', () => {
  const hostile = [
    ['truncated object', '{"type":"assist'],
    ['unterminated string', '{"type":"assistant","message":{"content":"oops'],
    ['raw garbage', 'not json at all <<<>>>'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['lone brace', '{'],
    ['trailing comma', '{"type":"result",}'],
    ['bare nan token', 'NaN'],
    ['half NDJSON', '{"a":1}\n{"b":'],
    ['deeply nested junk', '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"x":{"y":[1,2,3'],
  ] as const

  for (const [label, line] of hostile) {
    it(`returns null (no throw) for ${label}`, () => {
      let ev: ReturnType<typeof pc> | undefined
      expect(() => { ev = pc(line) }).not.toThrow()
      expect(ev).toBeNull()
    })
  }

  it('a valid scalar/array JSON line degrades to a bare assistant event (never throws)', () => {
    // JSON scalars/arrays parse fine; obj.type is undefined → mapType default
    // 'assistant'. Only `null` is dropped (member access on null throws → caught).
    expect(pc('123')!.type).toBe('assistant')
    expect(pc('true')!.type).toBe('assistant')
    expect(pc('"hello"')!.type).toBe('assistant')
    expect(pc('[]')!.type).toBe('assistant')
    expect(pc('null')).toBeNull()
  })

  it('a bare assistant event from a scalar line carries raw and no projections', () => {
    const ev = pc('42')!
    expect(ev.raw).toBe('42')
    expect(ev.text).toBeUndefined()
    expect(ev.tool).toBeUndefined()
    expect(ev.tokensIn).toBeUndefined()
  })
})

describe('S5 — mapType: every raw type maps deterministically (S5-006)', () => {
  it('system → system', () => expect(pc('{"type":"system","subtype":"init"}')!.type).toBe('system'))
  it('assistant → assistant', () => {
    const ev = pc('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')!
    expect(ev.type).toBe('assistant')
    expect(ev.text).toBe('hi')
  })
  it('user → user', () => {
    const ev = pc('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}')!
    expect(ev.type).toBe('user')
  })
  it('result → usage', () => expect(pc('{"type":"result","result":"done"}')!.type).toBe('usage'))
  it('unknown type → assistant, with NO enrichment branches firing', () => {
    // enrichment is gated on the RAW type string, so an unknown type yields a
    // bare assistant event carrying only `raw`.
    const ev = pc('{"type":"banana","message":{"content":[{"type":"text","text":"ignored"}],"usage":{"input_tokens":99}}}')!
    expect(ev.type).toBe('assistant')
    expect(ev.text).toBeUndefined()      // assistant-enrichment gated on type==='assistant'
    expect(ev.tokensIn).toBeUndefined()
  })
  it('missing type → assistant', () => expect(pc('{"message":{"content":[]}}')!.type).toBe('assistant'))
})

describe('S5 — result branch fallback chain (S5-007)', () => {
  it('non-string result field → text undefined, no crash', () => {
    const ev = pc('{"type":"result","result":{"nested":1},"total_cost_usd":0.2}')!
    expect(ev.text).toBeUndefined()
    expect(ev.costUsd).toBe(0.2)
  })
  it('cost_usd is the fallback when total_cost_usd is absent', () => {
    expect(pc('{"type":"result","cost_usd":0.5}')!.costUsd).toBe(0.5)
  })
  it('total_cost_usd wins over a legacy cost_usd', () => {
    expect(pc('{"type":"result","total_cost_usd":0.3,"cost_usd":0.9}')!.costUsd).toBe(0.3)
  })
  it('both cost fields absent → costUsd 0 (last-wins reset is intentional)', () => {
    expect(pc('{"type":"result","result":"done"}')!.costUsd).toBe(0)
  })
  it('old-CLI top-level token fields (no usage object) are honored', () => {
    const ev = pc('{"type":"result","input_tokens":10,"output_tokens":4,"total_cost_usd":0.01}')!
    expect(ev.tokensIn).toBe(10)
    expect(ev.tokensOut).toBe(4)
  })
  it('a non-object usage value does not crash (member access yields 0)', () => {
    const ev = pc('{"type":"result","usage":"not-an-object","total_cost_usd":0.01}')!
    expect(ev.tokensIn).toBe(0)
    expect(ev.tokensOut).toBe(0)
  })
})

describe('S5 — parseOllamaLine tolerance (S5-008)', () => {
  it('plain text → assistant text', () => {
    const ev = parseOllamaLine('hello from llama', RID, 1, CTX)!
    expect(ev.type).toBe('assistant')
    expect(ev.text).toBe('hello from llama')
  })
  it('NDJSON {response} → response text', () => {
    expect(parseOllamaLine('{"response":"tok","done":false}', RID, 1, CTX)!.text).toBe('tok')
  })
  it('malformed JSON is treated as plain text (never throws)', () => {
    let ev: ReturnType<typeof parseOllamaLine> | undefined
    expect(() => { ev = parseOllamaLine('{"response": "broken', RID, 1, CTX) }).not.toThrow()
    expect(ev!.text).toBe('{"response": "broken')
  })
  it('empty line → null', () => {
    expect(parseOllamaLine('', RID, 1, CTX)).toBeNull()
  })
  it('NDJSON with a non-string response falls back to the raw line text', () => {
    // response is not a string → text stays the raw line (no crash)
    const ev = parseOllamaLine('{"response":123,"done":true}', RID, 1, CTX)!
    expect(ev.text).toBe('{"response":123,"done":true}')
  })
})
