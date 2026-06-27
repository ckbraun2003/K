import { describe, it, expect } from 'vitest'
import type { AgentEvent, Run } from '@k/shared'
import { eventsToWorkflowTree } from '../src/lib/workflow'

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0
function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: `e${seq}`, runId: 'r', seq: seq++, type: 'assistant', ts: 0, ...over }
}

/** A delegate tool_use (assistant) event. */
function delegateCall(id: string, toolUseId: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return ev({
    id,
    type: 'assistant',
    toolKind: 'delegate',
    tool: 'Task',
    toolUseId,
    ...over,
  })
}

/** A tool_result (user) event paired by toolUseId. */
function delegateResult(toolUseId: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return ev({ type: 'user', toolUseId, ...over })
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    prompt: 'Do the batch',
    cwd: '/repo',
    status: 'running',
    provider: 'claude',
    model: 'claude-opus-4-8',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    createdAt: 0,
    ...over,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('eventsToWorkflowTree', () => {
  it('builds one child per delegate call with correct status / label / prompt / result', () => {
    const events: AgentEvent[] = [
      delegateCall('c1', 'toolu_1', {
        subagentType: 'implementer',
        childLabel: 'Build wave',
        toolInput: { prompt: 'implement the feature', description: 'Build wave' },
      }),
      delegateResult('toolu_1', { toolResult: [{ type: 'text', text: 'done building' }] }),
      // second delegate has no result → still running
      delegateCall('c2', 'toolu_2', {
        subagentType: 'spec-review',
        toolInput: { prompt: 'review the spec' },
      }),
    ]

    const tree = eventsToWorkflowTree(events, run())
    expect(tree.children).toHaveLength(2)

    const [a, b] = tree.children
    expect(a).toMatchObject({
      id: 'c1',
      agentType: 'implementer',
      label: 'Build wave',
      status: 'done',
      prompt: 'implement the feature',
      result: 'done building',
    })
    expect(b).toMatchObject({
      id: 'c2',
      agentType: 'spec-review',
      status: 'running',
      prompt: 'review the spec',
      result: '',
    })
  })

  it('maps an errored result to status "error"', () => {
    const events: AgentEvent[] = [
      delegateCall('c1', 'toolu_e', { toolInput: { prompt: 'go' } }),
      delegateResult('toolu_e', { toolResult: [{ type: 'text', text: 'boom' }], toolResultIsError: true }),
    ]
    const tree = eventsToWorkflowTree(events, run())
    expect(tree.children[0].status).toBe('error')
    expect(tree.children[0].result).toBe('boom')
  })

  it('defaults agentType to "default agent" when subagentType is absent', () => {
    const events: AgentEvent[] = [delegateCall('c1', 'toolu_d', { toolInput: { prompt: 'go' } })]
    expect(eventsToWorkflowTree(events, run()).children[0].agentType).toBe('default agent')
  })

  it('returns an empty children list when the run spawned no sub-agents', () => {
    expect(eventsToWorkflowTree([], run()).children).toEqual([])
  })

  it('ignores non-delegate tool calls (Bash / Write) and plain events', () => {
    const events: AgentEvent[] = [
      ev({ type: 'assistant', toolKind: 'command', tool: 'Bash', toolUseId: 'b1', toolInput: { command: 'ls' } }),
      delegateResult('b1', { toolResult: 'a\nb' }),
      ev({ type: 'assistant', toolKind: 'file', tool: 'Write', toolUseId: 'w1', toolInput: { file_path: '/x', content: 'y' } }),
      ev({ type: 'assistant', text: 'just talking' }),
      delegateCall('c1', 'toolu_1', { toolInput: { prompt: 'go' } }),
    ]
    const tree = eventsToWorkflowTree(events, run())
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].id).toBe('c1')
  })

  it('derives the root from the run (prompt / status / id)', () => {
    const tree = eventsToWorkflowTree([], run({ id: 'run-9', prompt: 'My run', status: 'done' }))
    expect(tree.root).toEqual({ runId: 'run-9', label: 'My run', status: 'done' })
  })

  it('falls back to a placeholder root when no run is given', () => {
    const tree = eventsToWorkflowTree([])
    expect(tree.root).toEqual({ runId: undefined, label: 'Run', status: 'running' })
  })

  it('never throws on malformed events (bad / missing field shapes)', () => {
    const malformed = [
      // delegate with a non-object toolInput and no result
      { id: 'm1', runId: 'r', seq: 0, ts: 0, type: 'assistant', toolKind: 'delegate', toolUseId: 'm', toolInput: 'not-an-object' },
      // near-empty event object
      { id: 'm2', runId: 'r', seq: 1, ts: 0, type: 'assistant' },
    ] as unknown as AgentEvent[]
    expect(() => eventsToWorkflowTree(malformed, run())).not.toThrow()
    // the delegate with a junk toolInput still yields one (empty-prompt) child
    expect(eventsToWorkflowTree(malformed, run()).children).toHaveLength(1)
  })
})
