/**
 * OrchestratorPipelinesPanel (orch-p2 C.3, design §6.2) — "the Chief manages
 * multiple running pipelines" made visible: pipeline_runs grouped by
 * `owner_profile_id` under each Chief-child orchestrator, plus an Unassigned
 * bucket for runs with no owner stamped yet (no dispatch path sets it in this
 * wave — see pipeline-engine.ts). Pure presentational; a page wires the fetches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { AgentProfile, PipelineRun } from '@k/shared'

import OrchestratorPipelinesPanel, { groupPipelineRunsByOwner } from '../src/components/OrchestratorPipelinesPanel'

function profile(id: string, name: string): AgentProfile {
  return {
    id, name, tier: 'orchestrator', charter: 'orchestrator',
    defaultModel: 'claude-sonnet-4-6', allowedTools: [], mcpServers: [], skills: [],
  }
}
function run(over: Partial<PipelineRun>): PipelineRun {
  return {
    id: 'r1', definitionId: 'd1', projectId: null, title: 'A run',
    status: 'running', createdAt: 0, updatedAt: 0, completedAt: null, ownerProfileId: null,
    ...over,
  }
}

const LEADS = [profile('lead-frontend', 'Frontend'), profile('lead-backend', 'Backend')]

afterEach(() => cleanup())

describe('groupPipelineRunsByOwner', () => {
  it('groups runs under their owning orchestrator, and buckets unowned runs as Unassigned', () => {
    const runs = [
      run({ id: 'r1', ownerProfileId: 'lead-frontend' }),
      run({ id: 'r2', ownerProfileId: 'lead-frontend' }),
      run({ id: 'r3', ownerProfileId: 'lead-backend' }),
      run({ id: 'r4', ownerProfileId: null }),
    ]
    const groups = groupPipelineRunsByOwner(runs, LEADS)

    const frontend = groups.find(g => g.profileId === 'lead-frontend')
    expect(frontend?.label).toBe('Frontend')
    expect(frontend?.runs.map(r => r.id)).toEqual(['r1', 'r2'])

    const backend = groups.find(g => g.profileId === 'lead-backend')
    expect(backend?.runs.map(r => r.id)).toEqual(['r3'])

    const unassigned = groups.find(g => g.profileId === null)
    expect(unassigned?.label).toBe('Unassigned')
    expect(unassigned?.runs.map(r => r.id)).toEqual(['r4'])
  })

  it('omits an orchestrator with zero runs — only owners that actually have pipelines appear', () => {
    const runs = [run({ id: 'r1', ownerProfileId: 'lead-frontend' })]
    const groups = groupPipelineRunsByOwner(runs, LEADS)
    expect(groups.map(g => g.profileId)).toEqual(['lead-frontend'])
  })

  it('returns nothing for an empty run list', () => {
    expect(groupPipelineRunsByOwner([], LEADS)).toEqual([])
  })
})

describe('OrchestratorPipelinesPanel', () => {
  it('renders one section per orchestrator with its run count and rows', () => {
    const runs = [
      run({ id: 'r1', ownerProfileId: 'lead-frontend', title: 'Ship the widget', status: 'running' }),
      run({ id: 'r2', ownerProfileId: 'lead-backend', title: 'Fix the bug', status: 'completed' }),
    ]
    render(<OrchestratorPipelinesPanel runs={runs} leads={LEADS} />)

    expect(screen.getByTestId('orchestrator-pipelines-group-lead-frontend').textContent).toContain('Frontend')
    expect(screen.getByTestId('orchestrator-pipelines-group-lead-backend').textContent).toContain('Backend')
    expect(screen.getByTestId('orchestrator-pipelines-run-r1').textContent).toContain('Ship the widget')
  })

  it('invokes onSelectRun when a run row is clicked', () => {
    const onSelectRun = vi.fn()
    const runs = [run({ id: 'r1', ownerProfileId: 'lead-frontend', title: 'Ship the widget' })]
    render(<OrchestratorPipelinesPanel runs={runs} leads={LEADS} onSelectRun={onSelectRun} />)

    fireEvent.click(screen.getByTestId('orchestrator-pipelines-run-r1'))
    expect(onSelectRun).toHaveBeenCalledWith('r1')
  })

  it('renders an empty state when no orchestrator owns any pipeline run', () => {
    render(<OrchestratorPipelinesPanel runs={[]} leads={LEADS} />)
    expect(screen.getByTestId('orchestrator-pipelines-empty')).toBeTruthy()
  })
})
