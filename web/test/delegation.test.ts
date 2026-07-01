import { describe, it, expect } from 'vitest'
import type { AgentEvent, AgentProfile, AgentRun, Run, ChiefOrgLead, ChiefOrgPayload } from '@k/shared'
import { orgToDelegationTree, leadNode } from '../src/lib/delegation'

// ─── Fixtures ───────────────────────────────────────────────────────────────

function profile(id: string, name: string, over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name,
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: 'claude-sonnet-4-6',
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...over,
  }
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-be',
    prompt: 'Ship the auth refactor',
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

let seq = 0
function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: `e${seq}`, runId: 'run-be', seq: seq++, type: 'assistant', ts: 0, ...over }
}
function delegateCall(id: string, toolUseId: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return ev({ id, type: 'assistant', toolKind: 'delegate', tool: 'Task', toolUseId, ...over })
}
function delegateResult(toolUseId: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return ev({ type: 'user', toolUseId, ...over })
}

function lead(over: Partial<ChiefOrgLead> = {}): ChiefOrgLead {
  return { profile: profile('lead-backend', 'Backend'), latestRun: null, events: [], wakes: [], ...over }
}

function wake(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `w${Math.random().toString(36).slice(2)}`,
    profileId: 'chief',
    runId: null,
    trigger: 'schedule',
    goal: 'rebalance',
    projectId: null,
    workflowId: null,
    status: 'completed',
    createdAt: 0,
    completedAt: null,
    ...over,
  }
}

function payload(over: Partial<ChiefOrgPayload> = {}): ChiefOrgPayload {
  return {
    chief: profile('chief', 'Chief', { tier: 'chief', charter: 'chief' }),
    leads: [],
    chiefWakes: [],
    assignments: [],
    health: { leadsActive: 0 },
    ...over,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('orgToDelegationTree', () => {
  it('builds a 3-level tree: Chief → lead → its delegate sub-agents, with statuses', () => {
    const events: AgentEvent[] = [
      delegateCall('c1', 'toolu_1', { subagentType: 'implementer', childLabel: 'Build wave', toolInput: { prompt: 'go' } }),
      delegateResult('toolu_1', { toolResult: [{ type: 'text', text: 'done' }] }),
      // second delegate has no result → still running
      delegateCall('c2', 'toolu_2', { subagentType: 'spec-review', toolInput: { prompt: 'review' } }),
    ]
    const tree = orgToDelegationTree(
      payload({
        leads: [lead({ latestRun: run({ status: 'running' }), events })],
      }),
    )

    // level 1 — Chief root
    expect(tree.id).toBe('chief')
    expect(tree.label).toBe('Chief')
    expect(tree.kind).toBe('chief')
    expect(tree.children).toHaveLength(1)

    // level 2 — the lead
    const be = tree.children[0]
    expect(be.id).toBe('lead-backend')
    expect(be.label).toBe('Backend')
    expect(be.kind).toBe('lead')
    expect(be.status).toBe('running') // latest run is running

    // level 3 — the lead's sub-agents (from its delegate events)
    expect(be.children).toHaveLength(2)
    expect(be.children[0]).toMatchObject({ id: 'c1', label: 'implementer', kind: 'sub-agent', status: 'done' })
    expect(be.children[1]).toMatchObject({ id: 'c2', label: 'spec-review', status: 'running' })
    expect(be.children[0].children).toEqual([]) // sub-agents are leaves
  })

  it('a lead with no latest run is idle with no children', () => {
    const tree = orgToDelegationTree(payload({ leads: [lead()] }))
    expect(tree.children[0].status).toBe('idle')
    expect(tree.children[0].children).toEqual([])
  })

  it('maps a lead\'s run status: done → done, error/killed → error', () => {
    const done = leadNode(lead({ latestRun: run({ status: 'done' }) }))
    expect(done.status).toBe('done')
    const errored = leadNode(lead({ latestRun: run({ status: 'error' }) }))
    expect(errored.status).toBe('error')
    const killed = leadNode(lead({ latestRun: run({ status: 'killed' }) }))
    expect(killed.status).toBe('error')
  })

  it('the Chief root is running only when a chief wake is live', () => {
    expect(orgToDelegationTree(payload()).status).toBe('idle')
    expect(orgToDelegationTree(payload({ chiefWakes: [wake({ status: 'running' })] })).status).toBe('running')
  })

  it('never throws on an empty / minimal payload', () => {
    expect(() => orgToDelegationTree(payload())).not.toThrow()
    const tree = orgToDelegationTree(payload())
    expect(tree.children).toEqual([])
  })
})
