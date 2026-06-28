import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WorkflowStep, WorkflowRun } from '@k/shared'
import WorkflowChecklist from '../src/components/WorkflowChecklist'

afterEach(() => cleanup())

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, 'id' | 'label' | 'kind' | 'status'>): WorkflowStep {
  return {
    workflowRunId: 'wf-1',
    seq: 1,
    workItemId: null,
    detail: null,
    updatedAt: 0,
    ...partial,
  }
}

const wfRun: WorkflowRun = {
  id: 'wf-1',
  projectId: 'p-1',
  runId: 'run-1',
  taskIds: [],
  mode: 'combined',
  status: 'running',
  completedAt: null,
  createdAt: 0,
}

describe('WorkflowChecklist', () => {
  it('renders each step with its label, kind badge, and status', () => {
    const steps: WorkflowStep[] = [
      step({ id: 's1', label: 'Implement X', kind: 'task', status: 'done' }),
      step({ id: 's2', label: 'spec-review', kind: 'review', status: 'in_progress', seq: 2 }),
      step({ id: 's3', label: 'CI', kind: 'ci', status: 'pending', seq: 3, detail: 'awaiting PR' }),
      step({ id: 's4', label: 'integrate fixes', kind: 'phase', status: 'blocked', seq: 4 }),
    ]
    render(<WorkflowChecklist steps={steps} workflowRun={wfRun} />)

    expect(screen.getByTestId('wf-step-s1').textContent).toContain('Implement X')
    expect(screen.getByTestId('wf-step-s1').textContent).toContain('ticket')
    expect(screen.getByTestId('wf-step-s2').textContent).toContain('spec-review')
    expect(screen.getByTestId('wf-step-s2').textContent).toContain('in progress')
    const ci = screen.getByTestId('wf-step-s3')
    expect(ci.textContent).toContain('CI')
    expect(ci.textContent).toContain('awaiting PR')
    // loop phase kind is surfaced too
    expect(screen.getByTestId('wf-step-s4').textContent).toContain('phase')
    expect(screen.getByTestId('wf-step-s4').textContent).toContain('blocked')
    // overall workflow status shown
    expect(screen.getByTestId('wf-overall-status').textContent).toContain('running')
  })

  it('omits the overall-status badge when no workflowRun is given', () => {
    render(<WorkflowChecklist steps={[step({ id: 's1', label: 'X', kind: 'task', status: 'pending' })]} workflowRun={null} />)
    expect(screen.queryByTestId('wf-overall-status')).toBeNull()
    expect(screen.getByTestId('wf-step-s1').textContent).toContain('X')
  })

  it('shows an empty state when no status has been reported', () => {
    render(<WorkflowChecklist steps={[]} workflowRun={wfRun} />)
    expect(screen.getByTestId('wf-checklist-empty').textContent).toContain('No status reported yet')
  })
})
