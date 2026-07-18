import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

it('a real stage tile is a keyboard-activable button that fires onSelect', () => {
  const onSelect = vi.fn()
  render(
    <ReactFlowProvider>
      <PipelineStageNode id="review" data={{ stage: stage({ kind: 'agent', status: 'running' }), isDone: false, onSelect }} />
    </ReactFlowProvider> as any,
  )
  const btn = screen.getByRole('button', { name: /stage review/i })
  fireEvent.keyDown(btn, { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledWith('review')
  fireEvent.keyDown(btn, { key: ' ' })
  expect(onSelect).toHaveBeenCalledTimes(2)
})

it('the done sink is not a button (non-interactive)', () => {
  render(<ReactFlowProvider><PipelineStageNode id="__done__" data={{ isDone: true }} /></ReactFlowProvider> as any)
  expect(screen.queryByRole('button')).toBeNull()
})

it('hides the attempt line for a not-yet-attempted stage (attempt 0 — e.g. a definition preview)', () => {
  render(
    <ReactFlowProvider>
      <PipelineStageNode id="s" data={{ stage: stage({ kind: 'agent', status: 'pending', attempt: 0, costUsd: null }), isDone: false }} />
    </ReactFlowProvider> as any,
  )
  expect(screen.getByText('pending')).toBeTruthy()
  expect(screen.queryByText(/attempt/i)).toBeNull()
})

it('a stage tile with no onSelect is non-interactive (read-only preview node)', () => {
  render(
    <ReactFlowProvider>
      <PipelineStageNode id="s" data={{ stage: stage({ kind: 'agent', status: 'running' }), isDone: false }} />
    </ReactFlowProvider> as any,
  )
  expect(screen.queryByRole('button')).toBeNull()
})
