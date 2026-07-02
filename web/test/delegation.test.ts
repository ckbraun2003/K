import { describe, it, expect } from 'vitest'
import type { AgentEvent, AgentProfile, AgentRun, Run, ChiefOrgLead, ChiefOrgPayload } from '@k/shared'
import { orgToDelegationTree, leadNode, fullOrgToDelegationTree } from '../src/lib/delegation'

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

  it('a lead with no latest run but recorded wakes is idle with an "N wakes" meta (singular/plural)', () => {
    const two = leadNode(lead({ wakes: [wake(), wake()] }))
    expect(two.status).toBe('idle')
    expect(two.meta).toBe('2 wakes')
    expect(two.children).toEqual([])

    const one = leadNode(lead({ wakes: [wake()] }))
    expect(one.meta).toBe('1 wake')
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

  it('the chief meta consumes the SERVER-authoritative leads-active count, not a client re-derivation', () => {
    // A running lead child but leadsActive: 0 from the server — the server number
    // wins (the old client-side predicate over children is gone: two computations
    // of one fact can only drift).
    const zero = orgToDelegationTree(
      payload({ leads: [lead({ latestRun: run({ status: 'running' }) })], leadsActive: 0 }),
    )
    expect(zero.meta).toBe('1 lead · 0 active')

    // Top-level leadsActive wins; absent → health.leadsActive; absent → 0.
    expect(orgToDelegationTree(payload({ leadsActive: 4 })).meta).toBe('0 leads · 4 active')
    expect(orgToDelegationTree(payload({ health: { leadsActive: 2 } })).meta).toBe('0 leads · 2 active')
    expect(orgToDelegationTree(payload()).meta).toBe('0 leads · 0 active')
  })

  it('carries runId onto the lead node (latest run) and the chief node (newest wake with a run)', () => {
    const be = leadNode(lead({ latestRun: run({ id: 'run-be-7' }) }))
    expect(be.runId).toBe('run-be-7')
    expect(leadNode(lead()).runId).toBeUndefined()

    const tree = orgToDelegationTree(
      payload({
        chiefWakes: [wake({ runId: null }), wake({ runId: 'run-chief-3' })],
      }),
    )
    // The first wake with a non-null runId wins (wakes arrive newest-first).
    expect(tree.runId).toBe('run-chief-3')
    expect(orgToDelegationTree(payload()).runId).toBeUndefined()
  })
})

describe('fullOrgToDelegationTree — the whole-org chain (user → K → Chief → lead → sub-agent)', () => {
  it('wraps the Chief subtree under the user + K ancestor tiers (5 levels)', () => {
    const events: AgentEvent[] = [
      delegateCall('c1', 'toolu_1', { subagentType: 'implementer', toolInput: { prompt: 'go' } }),
      delegateResult('toolu_1', { toolResult: [{ type: 'text', text: 'done' }] }),
    ]
    const tree = fullOrgToDelegationTree(
      payload({
        leads: [lead({ latestRun: run({ status: 'running' }), events })],
        chiefWakes: [wake({ status: 'running' })],
        kDelegations: 3,
      }),
    )

    // level 0 — the operator (user) root
    expect(tree.id).toBe('user')
    expect(tree.kind).toBe('user')
    expect(tree.children).toHaveLength(1)

    // level 1 — K, carrying the K→Chief delegation-edge count
    const k = tree.children[0]
    expect(k.id).toBe('k')
    expect(k.label).toBe('K')
    expect(k.meta).toContain('3 delegations to Chief')
    expect(k.children).toHaveLength(1)

    // level 2 — the existing Chief subtree, unchanged
    const chief = k.children[0]
    expect(chief.id).toBe('chief')
    expect(chief.kind).toBe('chief')

    // level 3 + 4 — lead → sub-agent still derived from the run events
    expect(chief.children[0].id).toBe('lead-backend')
    expect(chief.children[0].children[0]).toMatchObject({ id: 'c1', kind: 'sub-agent' })
  })

  it('K rides the chain — running when the Chief subtree is active, else idle', () => {
    const running = fullOrgToDelegationTree(payload({ chiefWakes: [wake({ status: 'running' })] }))
    expect(running.children[0].status).toBe('running') // K
    const idle = fullOrgToDelegationTree(payload())
    expect(idle.children[0].status).toBe('idle')
    // The loop-b2 window: the Chief's own activation has finalized (no live wake) but a lead
    // it dispatched is still running → K must stay running (it rides the whole subtree).
    const leadStillRunning = fullOrgToDelegationTree(
      payload({ leads: [lead({ latestRun: run({ status: 'running' }) })] }),
    )
    expect(leadStillRunning.children[0].status).toBe('running')
  })

  it('defaults kDelegations to 0 and never throws on a minimal payload', () => {
    expect(() => fullOrgToDelegationTree(payload())).not.toThrow()
    const tree = fullOrgToDelegationTree(payload())
    expect(tree.children[0].meta).toContain('0 delegations to Chief')
    // singular grammar when exactly one
    expect(fullOrgToDelegationTree(payload({ kDelegations: 1 })).children[0].meta).toContain(
      '1 delegation to Chief',
    )
  })
})
