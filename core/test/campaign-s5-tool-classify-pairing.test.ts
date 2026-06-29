/**
 * Campaign S5 — classifyTool table + tool_use/tool_result pairing edges (LOCK).
 *
 * Extends `providers-enrich.test.ts` (which pins the core Bash/Write/Task/Agent
 * mappings + happy-path enrichment). Here we hammer the GAPS: case-sensitivity,
 * whitespace/empty/mcp names, multi-block lines (first-wins tool_use, last-wins
 * text, first-paired tool_result), orphan tool_use, dangling tool_result, and
 * non-object / missing block fields. None of these may throw or mis-pair.
 *
 * NB: prototype-key tool names (`toString`, `constructor`, …) are a CONFIRMED
 * FAULT, codified red in regressions/s5-002-classifytool-prototype-pollution.
 *
 * Findings: S5-009 (classify table), S5-010 (pairing edges). See
 * testing/findings/S5-supervisor-providers-routing.md.
 */
import { describe, it, expect } from 'vitest'
import { parseClaudeLine, classifyTool } from '../src/providers.js'

const RID = '00000000-0000-0000-0000-000000000000'
const CTX = { tokensIn: 0, tokensOut: 0, costUsd: 0 }
const pc = (line: string) => parseClaudeLine(line, RID, 1, CTX)!

describe('S5 — classifyTool is exact-match + case-sensitive (S5-009)', () => {
  it('unknown real tools map to other', () => {
    for (const n of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput', 'Skill']) {
      expect(classifyTool(n)).toBe('other')
    }
  })
  it('mcp__ namespaced tools map to other', () => {
    expect(classifyTool('mcp__k-store__work_item_create')).toBe('other')
    expect(classifyTool('mcp__claude_ai_Gmail__authenticate')).toBe('other')
  })
  it('is case-sensitive (lowercase / uppercase variants are other)', () => {
    expect(classifyTool('bash')).toBe('other')
    expect(classifyTool('BASH')).toBe('other')
    expect(classifyTool('write')).toBe('other')
    expect(classifyTool('task')).toBe('other')
  })
  it('whitespace-padded and empty names are other (no trimming)', () => {
    expect(classifyTool(' Bash')).toBe('other')
    expect(classifyTool('Bash ')).toBe('other')
    expect(classifyTool('')).toBe('other')
    expect(classifyTool('   ')).toBe('other')
  })
  it('every known mapping still holds (regression guard)', () => {
    expect(classifyTool('Bash')).toBe('command')
    for (const f of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(classifyTool(f)).toBe('file')
    for (const d of ['Task', 'Agent']) expect(classifyTool(d)).toBe('delegate')
  })
})

describe('S5 — multi-block assistant line (S5-010)', () => {
  it('multiple tool_use blocks → FIRST wins (documented), rest live only in raw', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'one' } },
        { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/x' } },
      ] },
    })
    const ev = pc(line)
    expect(ev.tool).toBe('Bash')
    expect(ev.toolUseId).toBe('a')
    expect(ev.toolKind).toBe('command')
    expect(ev.raw).toContain('Write') // the second block survives in raw
  })

  it('multiple text blocks → LAST wins', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ] },
    })
    expect(pc(line).text).toBe('second')
  })

  it('text + tool_use in one line → both projected', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'running it' },
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
      ] },
    })
    const ev = pc(line)
    expect(ev.text).toBe('running it')
    expect(ev.tool).toBe('Bash')
  })
})

describe('S5 — tool_use enrichment robustness (S5-010)', () => {
  it('non-object block.input (string) does not crash; toolInput kept verbatim', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":"raw-string-input"}]}}'
    const ev = pc(line)
    expect(ev.tool).toBe('Bash')
    expect(ev.toolInput).toBe('raw-string-input')
  })
  it('null block.input → toolInput omitted (?? undefined)', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":null}]}}'
    expect(pc(line).toolInput).toBeUndefined()
  })
  it('missing name → tool "" and toolKind other', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","input":{}}]}}'
    const ev = pc(line)
    expect(ev.tool).toBe('')
    expect(ev.toolKind).toBe('other')
  })
  it('non-string id → toolUseId omitted', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":123,"name":"Bash","input":{}}]}}'
    expect(pc(line).toolUseId).toBeUndefined()
  })
  it('delegate with non-string subagent_type → subagentType omitted, label from prompt', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Task","input":{"subagent_type":42,"prompt":"go do research"}}]}}'
    const ev = pc(line)
    expect(ev.toolKind).toBe('delegate')
    expect(ev.subagentType).toBeUndefined()
    expect(ev.childLabel).toBe('go do research')
  })
  it('orphan tool_use (no matching result) is emitted as-is (parser does not pair)', () => {
    const ev = pc('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"orphan","name":"Bash","input":{"command":"x"}}]}}')
    expect(ev.toolUseId).toBe('orphan')
    expect(ev.toolResult).toBeUndefined()
  })
})

describe('S5 — tool_result pairing edges (S5-010)', () => {
  it('dangling tool_result (id matches nothing here) is emitted as-is', () => {
    const ev = pc('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"ghost","content":"stale"}]}}')
    expect(ev.type).toBe('user')
    expect(ev.toolUseId).toBe('ghost')
    expect(ev.toolResult).toBe('stale')
  })
  it('multiple tool_result blocks → only the FIRST is paired into structured fields', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'out-a' },
        { type: 'tool_result', tool_use_id: 'b', content: 'out-b' },
      ] },
    })
    const ev = pc(line)
    expect(ev.toolUseId).toBe('a')
    expect(ev.toolResult).toBe('out-a')
    expect(ev.raw).toContain('out-b') // the second survives only in raw
  })
  it('a user line with no tool_result block leaves tool fields undefined', () => {
    const ev = pc('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}')
    expect(ev.type).toBe('user')
    expect(ev.toolUseId).toBeUndefined()
    expect(ev.toolResult).toBeUndefined()
  })
})
