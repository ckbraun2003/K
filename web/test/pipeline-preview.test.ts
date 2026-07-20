/**
 * previewViewFromSpec — adapts a design-time PipelineSpec into the PipelineRunView
 * shape PipelineGraph already renders, so the definition inspector can show the
 * same visual DAG as a live run (every stage forced to 'pending', no run has
 * started). Covers the stage/edge mapping and confirms the mapped view still
 * lays out cleanly through the existing `layoutPipeline` (a node per stage plus
 * the DONE_NODE_ID sink when an edge targets 'done').
 */
import { describe, it, expect } from 'vitest'
import type { PipelineSpec } from '@k/shared'
import { previewViewFromSpec } from '../src/lib/pipeline-preview'
import { layoutPipeline, DONE_NODE_ID } from '../src/lib/pipeline-layout'

const SPEC: PipelineSpec = {
  name: 'Preview Test',
  version: 1,
  entry: 'stage-a',
  crossProject: false,
  stages: [
    {
      kind: 'agent', id: 'stage-a', label: 'Stage A', role: 'implementer',
      subagentType: null, profileId: null, model: null,
      promptScaffold: 'do it', planGate: false,
      hooks: [], injection: { mode: 'off', hints: [] },
      retry: { maxAttempts: 2, backoffMs: 0, retryOn: [] },
    },
    {
      kind: 'deterministic', id: 'stage-b', label: 'Stage B', action: { type: 'verify' },
      hooks: [], injection: { mode: 'off', hints: [] },
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    },
  ],
  edges: [{ from: 'stage-a', to: 'done', handoff: 'share-tree', when: 'always' }],
}

describe('previewViewFromSpec', () => {
  it('maps every spec stage to a pending PipelineStageRun keyed by stage id', () => {
    const view = previewViewFromSpec(SPEC)
    expect(view.stages).toHaveLength(2)
    for (const stage of view.stages) {
      expect(stage.status).toBe('pending')
      expect(stage.runId).toBeNull()
    }
    expect(view.stages[0].stageKey).toBe('stage-a')
    expect(view.stages[0].kind).toBe('agent')
    expect(view.stages[1].stageKey).toBe('stage-b')
    expect(view.stages[1].kind).toBe('deterministic')
  })

  it('maps edges 1:1, preserving from/to/handoff/when', () => {
    const view = previewViewFromSpec(SPEC)
    expect(view.edges).toEqual([{ from: 'stage-a', to: 'done', handoff: 'share-tree', when: 'always' }])
  })

  it('builds a valid run stub the graph does not need to read closely', () => {
    const view = previewViewFromSpec(SPEC)
    expect(view.run.id).toBe('preview')
    expect(view.run.title).toBe(SPEC.name)
    expect(typeof view.run.createdAt).toBe('number')
    expect(typeof view.run.updatedAt).toBe('number')
    expect(view.run.completedAt).toBeNull()
  })

  it('lays out to a node per stage plus the DONE_NODE_ID sink', () => {
    const { nodes } = layoutPipeline(previewViewFromSpec(SPEC))
    const ids = nodes.map(n => n.id)
    expect(ids).toContain('stage-a')
    expect(ids).toContain('stage-b')
    expect(ids).toContain(DONE_NODE_ID)
    expect(nodes).toHaveLength(3)
  })
})
