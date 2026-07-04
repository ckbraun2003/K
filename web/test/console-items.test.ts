import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@k/shared'
import {
  pairToolCalls,
  groupConsoleItems,
  isPending,
  isError,
  commandText,
  commandDescription,
  fileSummary,
  fileOp,
  fileDetail,
  delegateLabel,
  delegateChildLabel,
  delegatePrompt,
  delegateResultText,
  resultText,
  resolveToolKind,
  toolArgSummary,
  isCommandTool,
  type ToolItem,
} from '../src/lib/console'

// Build an AgentEvent from the D3 smoke-confirmed shapes.
function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: 'id', runId: 'r', seq: 0, type: 'assistant', ts: 0, ...over }
}
function toolItem(over: Partial<AgentEvent>, result?: Partial<AgentEvent>): ToolItem {
  return { kind: 'tool', call: ev({ type: 'assistant', ...over }), result: result ? ev({ type: 'user', ...result }) : undefined }
}

describe('pairToolCalls — join by toolUseId', () => {
  it('pairs an assistant tool_use with its later user tool_result', () => {
    const events: AgentEvent[] = [
      ev({ id: 'a', seq: 1, type: 'assistant', tool: 'Bash', toolKind: 'command', toolUseId: 'toolu_a', toolInput: { command: 'echo smoke-test', description: 'Run echo' } }),
      ev({ id: 'r', seq: 2, type: 'user', toolUseId: 'toolu_a', toolResult: 'smoke-test\n' }),
    ]
    const items = pairToolCalls(events)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tool')
    const t = items[0] as ToolItem
    expect(t.call.id).toBe('a')
    expect(t.result?.id).toBe('r')
  })

  it('does not also render the consumed tool_result as its own item', () => {
    const events: AgentEvent[] = [
      ev({ id: 'a', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 'toolu_a', toolInput: { command: 'x' } }),
      ev({ id: 'r', seq: 2, type: 'user', toolUseId: 'toolu_a', toolResult: 'out' }),
    ]
    const items = pairToolCalls(events)
    expect(items.map(i => i.kind)).toEqual(['tool'])
  })

  it('renders a tool_use with no result yet as pending', () => {
    const items = pairToolCalls([
      ev({ id: 'a', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 'toolu_a', toolInput: { command: 'x' } }),
    ])
    expect(items).toHaveLength(1)
    const t = items[0] as ToolItem
    expect(t.result).toBeUndefined()
    expect(isPending(t)).toBe(true)
  })

  it('passes non-tool events (system / assistant text / plain user) through in order', () => {
    const items = pairToolCalls([
      ev({ id: 's', seq: 1, type: 'system', text: 'session start' }),
      ev({ id: 'a', seq: 2, type: 'assistant', text: 'hello' }),
      ev({ id: 'u', seq: 3, type: 'user', text: 'a plain user message' }),
    ])
    expect(items.map(i => i.kind)).toEqual(['event', 'event', 'event'])
  })

  it('keeps relative order of tool items and passthrough events', () => {
    const items = pairToolCalls([
      ev({ id: 'a', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 't1', toolInput: { command: 'a' } }),
      ev({ id: 'ra', seq: 2, type: 'user', toolUseId: 't1', toolResult: 'a-out' }),
      ev({ id: 'txt', seq: 3, type: 'assistant', text: 'between' }),
      ev({ id: 'b', seq: 4, type: 'assistant', toolKind: 'file', toolUseId: 't2', toolInput: { file_path: '/x', content: 'hi' } }),
    ])
    expect(items.map(i => (i.kind === 'tool' ? i.call.id : i.event.id))).toEqual(['a', 'txt', 'b'])
  })

  it('drops an orphan user tool_result with no matching assistant tool_use', () => {
    const items = pairToolCalls([
      ev({ id: 'r', seq: 1, type: 'user', toolUseId: 'toolu_orphan', toolResult: 'dangling' }),
    ])
    expect(items).toEqual([])
  })

  it('emits one tool item when two assistant events share a toolUseId (replay guard)', () => {
    const items = pairToolCalls([
      ev({ id: 'a1', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 'dup', toolInput: { command: 'x' } }),
      ev({ id: 'a2', seq: 2, type: 'assistant', toolKind: 'command', toolUseId: 'dup', toolInput: { command: 'x' } }),
    ])
    expect(items).toHaveLength(1)
    expect((items[0] as ToolItem).call.id).toBe('a1')
  })
})

describe('groupConsoleItems — coalesce consecutive tool calls', () => {
  it('returns [] for empty input', () => {
    expect(groupConsoleItems([])).toEqual([])
  })

  it('coalesces consecutive tool items into a single segment keyed by the first call id', () => {
    const segments = groupConsoleItems([
      { kind: 'tool', call: ev({ id: 'a', seq: 1, toolUseId: 't1' }) },
      { kind: 'tool', call: ev({ id: 'b', seq: 2, toolUseId: 't2' }) },
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('tools')
    if (segments[0].type === 'tools') {
      expect(segments[0].key).toBe('a')
      expect(segments[0].items.map(i => i.call.id)).toEqual(['a', 'b'])
    }
  })

  it('splits a tools run when a passthrough event sits between two tool calls (3 segments)', () => {
    const segments = groupConsoleItems([
      { kind: 'tool', call: ev({ id: 'a', seq: 1, toolUseId: 't1' }) },
      { kind: 'event', event: ev({ id: 'txt', seq: 2, type: 'assistant', text: 'hi' }) },
      { kind: 'tool', call: ev({ id: 'b', seq: 3, toolUseId: 't2' }) },
    ])
    expect(segments.map(s => s.type)).toEqual(['tools', 'event', 'tools'])
  })

  it('end-to-end via pairToolCalls preserves a consecutive command+file group', () => {
    const segments = groupConsoleItems(pairToolCalls([
      ev({ id: 'a', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 't1', toolInput: { command: 'x' } }),
      ev({ id: 'b', seq: 2, type: 'assistant', toolKind: 'file', toolUseId: 't2', toolInput: { file_path: '/x', content: 'hi' } }),
    ]))
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('tools')
  })
})

describe('isError — tri-state', () => {
  it('true only when explicitly === true', () => {
    expect(isError(toolItem({ toolUseId: 't' }, { toolResultIsError: true }))).toBe(true)
    expect(isError(toolItem({ toolUseId: 't' }, { toolResultIsError: false }))).toBe(false)
    expect(isError(toolItem({ toolUseId: 't' }, {}))).toBe(false)
    expect(isError(toolItem({ toolUseId: 't' }))).toBe(false)
  })
})

describe('command derivation', () => {
  const item = toolItem({ toolKind: 'command', toolInput: { command: 'echo smoke-test', description: 'Run echo' } }, { toolResult: 'smoke-test\n' })
  it('reads command, description, and string result', () => {
    expect(commandText(item)).toBe('echo smoke-test')
    expect(commandDescription(item)).toBe('Run echo')
    expect(resultText(item)).toBe('smoke-test\n')
  })
  it('returns empty string for a missing command', () => {
    expect(commandText(toolItem({ toolKind: 'command', toolInput: {} }))).toBe('')
  })
})

describe('file derivation', () => {
  it('Write → write detail with content preview', () => {
    const item = toolItem({ toolKind: 'file', tool: 'Write', toolInput: { file_path: '/tmp/x.ts', content: 'hi' } })
    expect(fileSummary(item)).toBe('/tmp/x.ts')
    expect(fileOp(item)).toBe('write')
    expect(fileDetail(item)).toEqual({ type: 'write', content: 'hi' })
  })
  it('Edit → single diff hunk', () => {
    const item = toolItem({ toolKind: 'file', tool: 'Edit', toolInput: { file_path: '/a', old_string: 'foo', new_string: 'bar' } })
    expect(fileOp(item)).toBe('edit')
    expect(fileDetail(item)).toEqual({ type: 'diff', hunks: [{ oldText: 'foo', newText: 'bar' }] })
  })
  it('MultiEdit → one hunk per edit', () => {
    const item = toolItem({ toolKind: 'file', tool: 'MultiEdit', toolInput: { file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } })
    expect(fileOp(item)).toBe('multiedit')
    expect(fileDetail(item)).toEqual({ type: 'diff', hunks: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] })
  })
})

describe('delegate derivation', () => {
  it('default agent (no subagentType) uses childLabel', () => {
    const item = toolItem(
      { toolKind: 'delegate', toolUseId: 'toolu_c', subagentType: undefined, childLabel: 'Reply done', toolInput: { description: 'Reply done', prompt: 'reply with done' } },
      { toolResult: [{ type: 'text', text: 'done' }], toolResultIsError: false },
    )
    expect(delegateLabel(item)).toBe('default agent')
    expect(delegateChildLabel(item)).toBe('Reply done')
    expect(delegatePrompt(item)).toBe('reply with done')
    expect(delegateResultText(item)).toBe('done')
  })
  it('subagentType present is used as the label; result array is joined', () => {
    const item = toolItem(
      { toolKind: 'delegate', subagentType: 'Explore', childLabel: 'Do research', toolInput: { description: 'Do research', prompt: 'go', subagent_type: 'Explore' } },
      { toolResult: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] },
    )
    expect(delegateLabel(item)).toBe('Explore')
    expect(delegateResultText(item)).toBe('line one\nline two')
  })
  it('falls back to description when childLabel is absent', () => {
    const item = toolItem({ toolKind: 'delegate', toolInput: { description: 'desc here', prompt: 'p' } })
    expect(delegateChildLabel(item)).toBe('desc here')
  })
})

describe('resolveToolKind — display-side command upgrade (F-078)', () => {
  it('keeps a known toolKind as-is', () => {
    expect(resolveToolKind(toolItem({ toolKind: 'command', tool: 'Bash' }))).toBe('command')
    expect(resolveToolKind(toolItem({ toolKind: 'file', tool: 'Write' }))).toBe('file')
    expect(resolveToolKind(toolItem({ toolKind: 'delegate', tool: 'Task' }))).toBe('delegate')
  })
  it('upgrades a name-recognized shell tool the classifier tagged "other" to command', () => {
    expect(resolveToolKind(toolItem({ toolKind: 'other', tool: 'PowerShell', toolInput: { command: 'gh pr create' } }))).toBe('command')
    expect(resolveToolKind(toolItem({ toolKind: 'other', tool: 'pwsh', toolInput: { command: 'ls' } }))).toBe('command')
    expect(isCommandTool('powershell')).toBe(true)
    expect(isCommandTool('Read')).toBe(false)
  })
  it('leaves a genuinely-other tool as other', () => {
    expect(resolveToolKind(toolItem({ toolKind: 'other', tool: 'Read', toolInput: { file_path: '/x' } }))).toBe('other')
  })
})

describe('toolArgSummary — salient input arg (F-063)', () => {
  it('extracts the known salient key per tool', () => {
    expect(toolArgSummary(toolItem({ tool: 'Read', toolInput: { file_path: '/a/b.ts' } }))).toBe('/a/b.ts')
    expect(toolArgSummary(toolItem({ tool: 'ToolSearch', toolInput: { query: 'select:Read' } }))).toBe('select:Read')
    expect(toolArgSummary(toolItem({ tool: 'Glob', toolInput: { pattern: '**/*.ts' } }))).toBe('**/*.ts')
  })
  it('labels the first string field when no known key matches', () => {
    expect(toolArgSummary(toolItem({ tool: 'mcp__x__y', toolInput: { widget: 'gizmo' } }))).toBe('widget: gizmo')
  })
  it('returns empty string when there is no salient arg', () => {
    expect(toolArgSummary(toolItem({ tool: 'NoArgs', toolInput: {} }))).toBe('')
    expect(toolArgSummary(toolItem({ tool: 'BadInput', toolInput: 42 }))).toBe('')
  })
})

describe('defensive parsing — never throws on unexpected shapes', () => {
  it('tolerates a non-object toolInput', () => {
    const item = toolItem({ toolKind: 'file', toolUseId: 'x', toolInput: 42 })
    expect(() => fileDetail(item)).not.toThrow()
    expect(fileDetail(item)).toEqual({ type: 'unknown' })
    expect(fileSummary(item)).toBe('(unknown file)')
    expect(fileOp(item)).toBe('unknown')
    expect(commandText(item)).toBe('')
    expect(delegatePrompt(item)).toBe('')
  })
  it('tolerates a malformed delegate result (not string, not array)', () => {
    const item = toolItem({ toolKind: 'delegate' }, { toolResult: { unexpected: true } })
    expect(() => delegateResultText(item)).not.toThrow()
    expect(delegateResultText(item)).toBe('')
    expect(resultText(item)).toBe('')
  })
  it('tolerates result array with non-text blocks', () => {
    const item = toolItem({ toolKind: 'delegate' }, { toolResult: [{ type: 'image' }, { type: 'text', text: 'kept' }, 'raw'] })
    expect(delegateResultText(item)).toBe('kept')
  })
})
