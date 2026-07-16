/**
 * PipelineGraph (D-119 C3) — the pure topological-layout helpers plus a light render
 * smoke: the DAG mounts a small PipelineRunView (with `canonical` omitted, exercising
 * the derive-from-status path) without throwing, laying out one node per stage + the
 * synthetic `done` sink and one SVG edge per non-entry edge.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PipelineRunView } from '@k/shared'
import PipelineGraph, { pipelineDepths, layoutPipeline } from '../src/components/PipelineGraph'

afterEach(() => cleanup())

function view(): PipelineRunView {
  return {
    run: {
      id: 'pr1', definitionId: 'd1', projectId: null, title: 'Ship it',
      status: 'running', createdAt: 0, updatedAt: 0, completedAt: null,
    },
    stages: [
      {
        id: 's1', pipelineRunId: 'pr1', stageKey: 'implement', kind: 'agent', status: 'passed',
        runId: 'r1', attempt: 1, maxAttempts: 1, repairs: 0, costUsd: 0.12,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: null,
        startedAt: 0, completedAt: 1,
      },
      {
        id: 's2', pipelineRunId: 'pr1', stageKey: 'review', kind: 'gate', status: 'awaiting_gate',
        runId: null, attempt: 1, maxAttempts: 1, repairs: 0, costUsd: null,
        failureClass: null, gateNote: null, baseCommit: null, resultCommit: null,
        startedAt: null, completedAt: null,
      },
    ],
    edges: [
      { from: null, to: 'implement', handoff: 'share-tree', when: 'always' },
      { from: 'implement', to: 'review', handoff: 'share-tree', when: 'pass' },
      { from: 'review', to: 'done', handoff: 'merge', when: 'pass' },
    ],
  }
}

describe('pipelineDepths', () => {
  it('assigns longest-path columns from the edge set', () => {
    const d = pipelineDepths(view())
    expect(d.get('implement')).toBe(0)
    expect(d.get('review')).toBe(1)
  })
})

describe('layoutPipeline', () => {
  it('lays out a node per stage + a done sink, and one edge per non-entry edge', () => {
    const l = layoutPipeline(view())
    const keys = l.nodes.map(n => n.key).sort()
    expect(keys).toContain('implement')
    expect(keys).toContain('review')
    expect(keys).toContain('__done__')
    // The `from: null` entry edge is not drawable (no source node) — 2 remain.
    expect(l.edges).toHaveLength(2)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
  })
})

describe('PipelineGraph render', () => {
  it('renders the DAG with a node tile per stage without throwing', () => {
    render(<PipelineGraph view={view()} />)
    expect(screen.getByTestId('pipeline-graph')).toBeTruthy()
    expect(screen.getByTestId('pipeline-node-implement')).toBeTruthy()
    expect(screen.getByTestId('pipeline-node-review')).toBeTruthy()
    expect(screen.getByTestId('pipeline-node-__done__')).toBeTruthy()
    expect(screen.getByText('implement')).toBeTruthy()
  })
})
