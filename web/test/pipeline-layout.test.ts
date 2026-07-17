import { it, expect } from 'vitest'
import { layoutPipeline } from '../src/lib/pipeline-layout'
import type { PipelineRunView } from '@k/shared'

const view: PipelineRunView = {
  run: { id: 'r1', definitionId: 'd1', projectId: null, title: 'T', status: 'running', createdAt: 0, updatedAt: 0, completedAt: null, ownerProfileId: null },
  stages: [
    { id: 's1', pipelineRunId: 'r1', stageKey: 'plan', kind: 'agent', status: 'passed', runId: null, attempt: 1, maxAttempts: 2, repairs: 0, costUsd: 0.01, failureClass: null, gateNote: null, baseCommit: null, resultCommit: null, startedAt: null, completedAt: null },
    { id: 's2', pipelineRunId: 'r1', stageKey: 'impl', kind: 'agent', status: 'running', runId: null, attempt: 1, maxAttempts: 2, repairs: 0, costUsd: null, failureClass: null, gateNote: null, baseCommit: null, resultCommit: null, startedAt: null, completedAt: null },
  ],
  edges: [
    { from: null, to: 'plan', handoff: 'share-tree', when: 'always' },
    { from: 'plan', to: 'impl', handoff: 'share-tree', when: 'pass' },
    { from: 'impl', to: 'done', handoff: 'share-tree', when: 'always' },
    { from: 'impl', to: 'plan', handoff: 'share-tree', when: 'loop' },
  ],
}

it('assigns a position to every stage + the done sink', () => {
  const { nodes, edges } = layoutPipeline(view)
  expect(nodes.map(n => n.id).sort()).toEqual(['__done__', 'impl', 'plan'])
  for (const n of nodes) {
    expect(Number.isFinite(n.position.x)).toBe(true)
    expect(Number.isFinite(n.position.y)).toBe(true)
  }
  // entry edge (from:null) is dropped; the loop back-edge is kept and retargets to 'plan'
  expect(edges.find(e => e.source === 'impl' && e.target === 'plan')?.data.when).toBe('loop')
  // the 'done' target maps to the sink node id
  expect(edges.find(e => e.target === '__done__')).toBeTruthy()

  // Topological ordering holds (rankdir 'LR'): plan → impl → done ranks left→right.
  // Guards against a dagre misconfiguration that collapses every node to one rank.
  const x = (id: string) => nodes.find(n => n.id === id)!.position.x
  expect(x('plan')).toBeLessThan(x('impl'))
  expect(x('impl')).toBeLessThan(x('__done__'))
})
