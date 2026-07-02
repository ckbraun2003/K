import { describe, it, expect } from 'vitest'
import type { AgentProfile, ChiefOrgLead, Run } from '@k/shared'
import { leadNode } from '../src/lib/delegation'

/**
 * OrchestratorDetailPage builds its right-panel "Live delegation" tree by passing
 * `leadNode(detail)` (the reused pure builder) into the shared DelegationTree — no
 * bespoke re-derivation. This pins that contract: given the reused ChiefOrgLead detail
 * wire shape, leadNode yields the expected single-lead root the component renders.
 */

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'lead-frontend',
    name: 'Frontend',
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
    id: 'run-fe',
    prompt: 'add focus ring to the cmd bar',
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

function detail(over: Partial<ChiefOrgLead> = {}): ChiefOrgLead {
  return { profile: profile(), latestRun: null, events: [], wakes: [], ...over }
}

describe('OrchestratorDetailPage tree contract (leadNode reuse)', () => {
  it('builds a single-lead root from the detail profile', () => {
    const root = leadNode(detail())
    expect(root.id).toBe('lead-frontend')
    expect(root.label).toBe('Frontend')
    expect(root.kind).toBe('lead')
    // No latest run → idle, no children.
    expect(root.status).toBe('idle')
    expect(root.children).toEqual([])
  })

  it('reflects a live run in the root status + meta', () => {
    const root = leadNode(detail({ latestRun: run({ status: 'running' }) }))
    expect(root.status).toBe('running')
    expect(root.meta).toContain('add focus ring')
  })
})

// The OrchestratorCard recent-health render tests live in orchestrators-card.test.tsx
// (component tests need jsdom; this .test.ts file runs in the node environment).
