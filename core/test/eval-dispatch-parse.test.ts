/**
 * Unit tests for the exported pure parser finalize() (core/src/eval/dispatch.ts) — the stream-json →
 * structured-result mapping ported from testing/eval/harness/dispatch.mjs. Feeds fabricated
 * stream-json stdout lines; NEVER spawns claude.exe.
 */
import { describe, it, expect } from 'vitest'
import { finalize } from '../src/eval/dispatch.js'
import type { RawDispatch } from '../src/eval/types.js'

function raw(stdout: string, over: Partial<RawDispatch> = {}): RawDispatch {
  return { outcome: 'closed', code: 0, ms: 100, stdout, stderr: '', ...over }
}

describe('finalize() — stream-json → DispatchResult', () => {
  it('parses assistant tool_use/text blocks + the result event', () => {
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Working on it' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { path: 'README.md' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }, // duplicate name → deduped
      ] } },
      { type: 'result', result: 'Final answer.', is_error: false, stop_reason: 'end_turn',
        num_turns: 4, total_cost_usd: 0.12,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Write' }],
        modelUsage: { 'claude-sonnet-4-6': {} } },
    ]
    const stdout = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
    const r = finalize(raw(stdout))

    expect(r.text).toBe('Final answer.')           // result.result preferred over assistant text
    expect(r.toolNames).toEqual(['Bash', 'Read'])   // deduped, in first-seen order
    expect(r.deniedTools).toEqual(['Write'])        // deduped
    expect(r.costUsd).toBe(0.12)
    expect(r.numTurns).toBe(4)
    expect(r.stopReason).toBe('end_turn')
    expect(r.isError).toBe(false)
    expect(r.usage?.input_tokens).toBe(10)
    expect(r.usage?.output_tokens).toBe(5)
    expect(r.modelUsed).toBe('claude-sonnet-4-6')
    expect(r.toolUses).toHaveLength(3)
    expect(r.eventCount).toBe(4)
    expect(r.outcome).toBe('closed')
  })

  it('falls back to concatenated assistant text when there is no result event', () => {
    const stdout = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'line one' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'line two' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n'
    const r = finalize(raw(stdout))
    expect(r.text).toBe('line one\nline two')       // assistantText.trim()
    expect(r.isError).toBeNull()                     // no result event
    expect(r.costUsd).toBeNull()
    expect(r.numTurns).toBeNull()
  })

  it('skips blank and non-JSON lines without throwing', () => {
    const stdout = [
      '',
      'not json at all',
      JSON.stringify({ type: 'result', result: 'ok', is_error: false }),
      '   ',
    ].join('\n')
    const r = finalize(raw(stdout))
    expect(r.text).toBe('ok')
    expect(r.eventCount).toBe(1)                     // only the valid JSON line counted
  })

  it('carries raw outcome/code/error/stderr metadata through', () => {
    const r = finalize(raw('', { outcome: 'spawn_error', error: 'ENOENT', code: null, stderr: 'boom' }))
    expect(r.outcome).toBe('spawn_error')
    expect(r.error).toBe('ENOENT')
    expect(r.code).toBeNull()
    expect(r.text).toBe('')
    expect(r.stderrTail).toBe('boom')
  })
})
