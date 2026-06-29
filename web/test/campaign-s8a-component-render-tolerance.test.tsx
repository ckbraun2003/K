import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WorkflowStep } from '@k/shared'
import WorkflowChecklist from '../src/components/WorkflowChecklist'
import ContextMeter from '../src/components/ContextMeter'
import ToolCall from '../src/components/ToolCall'
import type { ContextPressure } from '../src/lib/context'
import type { ToolItem } from '../src/lib/console'
import type { AgentEvent } from '@k/shared'

/**
 * S8a LOCK — component render-tolerance for malformed-but-survivable inputs.
 *
 * These pin the cases that DO degrade gracefully today, as the COMPLEMENT to the
 * confirmed crashers in regressions/ (s8a-002 unknown status; ContextMeter's
 * undefined-tokens contract note). Charter: a component fed a malformed item
 * renders without throwing.
 */

// jsdom has no matchMedia; framer-motion (used by ToolCall) may probe it.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})
afterEach(() => cleanup())

function step(over: Partial<WorkflowStep> & Pick<WorkflowStep, 'id' | 'label' | 'kind' | 'status'>): WorkflowStep {
  return { workflowRunId: 'wf-1', seq: 1, workItemId: null, detail: null, updatedAt: 0, ...over }
}
function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: 'id', runId: 'r', seq: 0, type: 'assistant', ts: 0, ...over }
}

describe('S8a — WorkflowChecklist tolerates an unknown step KIND', () => {
  it('renders the row (empty kind badge) without throwing — only status is fatal', () => {
    const s = step({ id: 's1', label: 'Odd kind', kind: 'mystery' as WorkflowStep['kind'], status: 'pending' })
    expect(() => render(<WorkflowChecklist steps={[s]} workflowRun={null} />)).not.toThrow()
    expect(screen.getByTestId('wf-step-s1').textContent).toContain('Odd kind')
  })
})

describe('S8a — ContextMeter tolerates out-of-range / non-finite percents', () => {
  function pressure(over: Partial<ContextPressure>): ContextPressure {
    return { tokens: 0, limit: 200_000, percent: 0, band: 'ok', ...over }
  }
  it('a NaN, negative, or >100 percent renders without throwing', () => {
    for (const percent of [NaN, -25, 150]) {
      expect(() => render(<ContextMeter pressure={pressure({ percent, tokens: 5000 })} />)).not.toThrow()
      cleanup()
    }
    render(<ContextMeter pressure={pressure({ percent: 150, tokens: 5000 })} />)
    expect(screen.getByTestId('context-meter')).toBeTruthy()
  })
})

describe('S8a — ToolCall renders an unknown tool with a hostile result', () => {
  it('toolKind undefined routes to OtherCall and survives a non-string/array result', () => {
    const item: ToolItem = {
      kind: 'tool',
      call: ev({ id: 'a', toolUseId: 't', tool: 'MysteryTool', toolKind: undefined, toolInput: [1, 2, 3] as unknown as AgentEvent['toolInput'] }),
      result: ev({ type: 'user', toolUseId: 't', toolResult: { nested: { weird: true } } as unknown as AgentEvent['toolResult'] }),
    }
    expect(() => render(<ToolCall item={item} />)).not.toThrow()
    expect(screen.getByTestId('tool-other').textContent).toContain('MysteryTool')
  })
})
