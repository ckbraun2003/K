/**
 * authority.ts — tier-ceiling guards (B1).
 *
 * toolWithinCeiling: the pure membership predicate — exact ceiling member,
 * specifier-narrowed form (`Bash(git:*)` narrows `Bash`), or a per-tool MCP grant
 * under a server-level grant (`mcp__kstore__get_x` narrows `mcp__kstore`).
 *
 * assertTierCeiling: the fail-closed guard the profile store + PATCH routes rely
 * on — a per-profile allowedTools row may only NARROW within the tier's asset
 * allowlist (the ceiling). Its "exceeds the … tier ceiling" message is
 * load-bearing (routes regex on it → 400).
 *
 * Pure fs (the committed agent-config assets) — no DB rows created.
 */
import { describe, it, expect } from 'vitest'
import { toolWithinCeiling, assertTierCeiling, resolveAuthority } from '../src/authority.js'

describe('toolWithinCeiling', () => {
  const ceiling = new Set(['Bash', 'Read', 'Grep', 'mcp__kstore'])

  it('exact ceiling member is within', () => {
    expect(toolWithinCeiling('Bash', ceiling)).toBe(true)
    expect(toolWithinCeiling('Read', ceiling)).toBe(true)
  })

  it('a specifier-narrowed form narrows its base tool', () => {
    expect(toolWithinCeiling('Bash(git:*)', ceiling)).toBe(true)
    expect(toolWithinCeiling('Bash(npm run test:*)', ceiling)).toBe(true)
    // …but only when the BASE is in the ceiling.
    expect(toolWithinCeiling('Write(src/*)', ceiling)).toBe(false)
  })

  it('a per-tool MCP grant narrows its server-level grant', () => {
    expect(toolWithinCeiling('mcp__kstore__get_x', ceiling)).toBe(true)
    expect(toolWithinCeiling('mcp__kstore__create_work_item', ceiling)).toBe(true)
    // an ungranted server's per-tool form misses
    expect(toolWithinCeiling('mcp__ghost__get_x', ceiling)).toBe(false)
    // a bare unknown server-level grant misses
    expect(toolWithinCeiling('mcp__ghost', ceiling)).toBe(false)
  })

  it('misses: unknown tools, dead tokens, empty ceiling', () => {
    expect(toolWithinCeiling('Task', ceiling)).toBe(false)
    expect(toolWithinCeiling('Agent', ceiling)).toBe(false)
    expect(toolWithinCeiling('Bash', new Set<string>())).toBe(false)
    // a leading '(' has no base to narrow (idx must be > 0)
    expect(toolWithinCeiling('(weird)', ceiling)).toBe(false)
  })
})

describe('assertTierCeiling', () => {
  it('an orchestrator subset passes (narrowing is the point)', () => {
    expect(() => assertTierCeiling('orchestrator', ['Read', 'Grep', 'mcp__kstore'])).not.toThrow()
    // the full tier asset trivially passes too
    expect(() =>
      assertTierCeiling('orchestrator', resolveAuthority('orchestrator').allowedTools),
    ).not.toThrow()
  })

  it("the dead 'Agent' token exceeds the ceiling at every tier (D-032)", () => {
    for (const tier of ['orchestrator', 'chief', 'secretary'] as const) {
      expect(() => assertTierCeiling(tier, ['Agent'])).toThrow(/exceeds the .* tier ceiling/)
    }
  })

  it("'Bash' at the chief tier exceeds the ceiling (coding tools are orchestrator-only)", () => {
    expect(() => assertTierCeiling('chief', ['Bash'])).toThrow(/exceeds the "chief" tier ceiling/)
  })

  it('a per-tool mcp grant under a server-level grant passes', () => {
    // orchestrator grants mcp__kstore at the server level; a narrowed per-tool
    // grant is WITHIN that ceiling.
    expect(() => assertTierCeiling('orchestrator', ['mcp__kstore__get_work_item'])).not.toThrow()
  })
})
