/**
 * QUARANTINE — CONFIRMED FAULT S5-002 (RED by design).
 * Finding: testing/findings/S5-supervisor-providers-routing.md → row S5-002.
 *
 * Surface: core/src/providers.ts `classifyTool` (lines ~53-65).
 *
 * Defect: TOOL_KIND is a plain object literal and classifyTool does
 *   `return TOOL_KIND[name] ?? 'other'`.
 * For any tool `name` that collides with an inherited Object.prototype member
 * (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
 * `__proto__`, …) the lookup resolves to that inherited member (a Function or the
 * prototype object), so `?? 'other'` never fires. classifyTool then returns a
 * value OUTSIDE its declared union `'command'|'file'|'delegate'|'other'`.
 *
 * Downstream impact (providers.ts:106): parseClaudeLine sets
 *   event.toolKind = classifyTool(name)
 * so a tool_use whose name is a prototype key gets a non-enum toolKind. The
 * supervisor's validateAgentEvent then fails AgentEventSchema (toolKind enum) and
 * DROPS THE WHOLE EVENT — the tool_use AND any sibling assistant text in that
 * line silently vanish from the stream/store. An MCP server is free to register a
 * tool literally named `toString`/`constructor`, so this is reachable.
 *
 * EXPECTED (post-fix, e.g. `Object.create(null)` map or an `Object.hasOwn`
 * guard): classifyTool returns one of the four enum strings for EVERY input →
 * test goes green, moves to gating.
 * ACTUAL (today): classifyTool('toString') returns a Function, etc. → RED.
 *
 * Document-only: imports the real providers module; does not edit core/src/**.
 */
import { describe, it, expect } from 'vitest'
import { classifyTool, parseClaudeLine } from '../../src/providers.js'

const KINDS = ['command', 'file', 'delegate', 'other'] as const
const PROTO_KEYS = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']
const RID = '00000000-0000-0000-0000-000000000000'
const CTX = { tokensIn: 0, tokensOut: 0, costUsd: 0 }

describe('S5-002 — classifyTool must return an enum kind for prototype-key names (RED)', () => {
  for (const name of PROTO_KEYS) {
    it(`classifyTool(${JSON.stringify(name)}) is one of the four kinds`, () => {
      // EXPECTED-SAFE: every input maps to a valid kind string.
      // ACTUAL today: returns an inherited Function/object → not in KINDS → red.
      expect(KINDS).toContain(classifyTool(name) as (typeof KINDS)[number])
    })
  }

  it('a tool_use named "toString" yields a string toolKind (event would survive validation)', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"toString","input":{}}]}}'
    const ev = parseClaudeLine(line, RID, 1, CTX)!
    // EXPECTED-SAFE: toolKind is a string ('other') so the schema accepts the event.
    // ACTUAL today: toolKind is a Function → AgentEventSchema drops the whole event.
    expect(typeof ev.toolKind).toBe('string')
  })
})
