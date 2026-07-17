import { it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import PipelineStageNode from '../src/components/PipelineStageNode'
import type { PipelineStageRun } from '@k/shared'

afterEach(() => cleanup())
const stage = (over: Partial<PipelineStageRun> = {}): PipelineStageRun => ({
  id: 'x', pipelineRunId: 'r', stageKey: 'review', kind: 'gate', status: 'awaiting_gate',
  runId: null, attempt: 1, maxAttempts: 2, repairs: 0, costUsd: null, failureClass: null,
  gateNote: null, baseCommit: null, resultCommit: null, startedAt: null, completedAt: null, ...over,
})
it('shows stageKey + a gate pill for a gate stage', () => {
  render(<ReactFlowProvider><PipelineStageNode id="review" data={{ stage: stage(), isDone: false }} /></ReactFlowProvider> as any)
  expect(screen.getByText('review')).toBeTruthy()
  // exact match (not /gate/i) — the status text below also renders 'awaiting_gate',
  // which would otherwise multi-match a substring regex
  expect(screen.getByText('gate')).toBeTruthy()
})
