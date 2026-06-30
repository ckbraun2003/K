/**
 * REGRESSION — FAULT S8-002 (FIXED + promoted to gating, reboot wave F1.W4d).
 *
 * Surface: web/src/components/WorkflowChecklist.tsx (STATUS[s.status] lookup, lines 53/60/70).
 *
 * Expected: a step whose `status` is outside the known enum
 *   (pending|in_progress|done|blocked|failed) renders with a neutral fallback
 *   glyph/colour, and — critically — sibling rows with valid statuses still
 *   render.
 * Actual: `STATUS[s.status]` returns undefined and `st.cls`/`st.icon` throw
 *   `TypeError: Cannot read properties of undefined (reading 'cls')` — the WHOLE
 *   checklist subtree fails to render (blank region), losing the good siblings.
 *
 * REACHABILITY (Low/latent): an out-of-enum status is NOT producible from shipped
 *   data — it is double-gated before the component: the only writer parses
 *   `status: WorkflowStepStatusSchema` (core/src/mcp/k-store.ts:202,207) and the
 *   column is `CHECK(status IN (…))` (core/src/db.ts:219-220). Strictly more
 *   guarded than the non-codified S8-011. The realistic vector is ENUM-DRIFT (a
 *   new status added to the tool schema + DB CHECK but not to this component's
 *   STATUS map). This RED test is retained as a forward-compat blast-radius guard
 *   (one bad row must not blank its siblings), not because the input is reachable
 *   today. Flips GREEN once WorkflowChecklist falls back for an unknown status.
 *
 * prober: PROBER-B · validator: VALIDATOR-B
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WorkflowStep } from '@k/shared'
import WorkflowChecklist from '../src/components/WorkflowChecklist'

afterEach(() => cleanup())

function step(over: Partial<WorkflowStep> & Pick<WorkflowStep, 'id' | 'label' | 'kind' | 'status'>): WorkflowStep {
  return { workflowRunId: 'wf-1', seq: 1, workItemId: null, detail: null, updatedAt: 0, ...over }
}

describe('S8-002 — unknown step status must not blank-screen the checklist', () => {
  it('renders a step with an out-of-enum status without throwing', () => {
    const bad = step({ id: 's1', label: 'Mystery step', kind: 'task', status: 'cancelled' as WorkflowStep['status'] })
    expect(() => render(<WorkflowChecklist steps={[bad]} workflowRun={null} />)).not.toThrow()
    expect(screen.getByTestId('wf-step-s1').textContent).toContain('Mystery step')
  })

  it('one bad-status step does not take down its valid siblings', () => {
    const steps: WorkflowStep[] = [
      step({ id: 'good', label: 'Done step', kind: 'task', status: 'done' }),
      step({ id: 'bad', label: 'Weird step', kind: 'review', status: '' as WorkflowStep['status'], seq: 2 }),
    ]
    expect(() => render(<WorkflowChecklist steps={steps} workflowRun={null} />)).not.toThrow()
    // The valid sibling must still be in the DOM (charter: no lost rows).
    expect(screen.getByTestId('wf-step-good').textContent).toContain('Done step')
    expect(screen.getByTestId('wf-step-bad').textContent).toContain('Weird step')
  })
})
