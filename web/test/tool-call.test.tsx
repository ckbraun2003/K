import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MotionConfig } from 'framer-motion'
import type { AgentEvent } from '@k/shared'
import { CommandCall, FileCall, DelegateCall } from '../src/components/ToolCall'
import type { ToolItem } from '../src/lib/console'

// jsdom has no matchMedia; framer may probe it. Provide an inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => cleanup())

function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: 'id', runId: 'r', seq: 0, type: 'assistant', ts: 0, ...over }
}
function item(over: Partial<AgentEvent>, result?: Partial<AgentEvent>): ToolItem {
  return {
    kind: 'tool',
    call: ev({ type: 'assistant', ...over }),
    result: result ? ev({ type: 'user', ...result }) : undefined,
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

describe('CommandCall', () => {
  const cmd = () =>
    item(
      { toolKind: 'command', tool: 'Bash', toolUseId: 'toolu_a', toolInput: { command: 'echo smoke-test', description: 'Run echo' } },
      { toolUseId: 'toolu_a', toolResult: 'smoke-test\n' },
    )

  it('shows the $ command summary and reveals output only when expanded', async () => {
    const user = userEvent.setup()
    const { container } = render(<CommandCall item={cmd()} />)
    expect(screen.getByText('echo smoke-test')).toBeTruthy()
    // collapsed by default — output + description absent
    expect(container.textContent).not.toContain('Run echo')

    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('Run echo')
    expect(screen.getByText('smoke-test')).toBeTruthy()
  })
})

// ─── File ─────────────────────────────────────────────────────────────────────

describe('FileCall', () => {
  it('Write: shows path, reveals content preview on expand', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <FileCall item={item({ toolKind: 'file', tool: 'Write', toolUseId: 'toolu_b', toolInput: { file_path: '/tmp/x.ts', content: 'hello-content' } })} />,
    )
    expect(container.textContent).toContain('/tmp/x.ts')
    expect(container.textContent).not.toContain('hello-content')

    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('hello-content')
  })

  it('Edit: reveals old→new diff on expand', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <FileCall item={item({ toolKind: 'file', tool: 'Edit', toolInput: { file_path: '/a.ts', old_string: 'OLD_LINE', new_string: 'NEW_LINE' } })} />,
    )
    expect(container.textContent).not.toContain('OLD_LINE')
    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('OLD_LINE')
    expect(container.textContent).toContain('NEW_LINE')
  })

  it('MultiEdit: renders one labelled hunk per edit on expand', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <FileCall
        item={item({ toolKind: 'file', tool: 'MultiEdit', toolInput: { file_path: '/m.ts', edits: [
          { old_string: 'AAA', new_string: 'BBB' },
          { old_string: 'CCC', new_string: 'DDD' },
        ] } })}
      />,
    )
    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('Edit 1')
    expect(container.textContent).toContain('Edit 2')
    expect(container.textContent).toContain('AAA')
    expect(container.textContent).toContain('BBB')
    expect(container.textContent).toContain('CCC')
    expect(container.textContent).toContain('DDD')
  })
})

// ─── Delegate ─────────────────────────────────────────────────────────────────

describe('DelegateCall', () => {
  it('default agent: shows "default agent" + label, reveals prompt + result on expand', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <DelegateCall
        item={item(
          { toolKind: 'delegate', toolUseId: 'toolu_c', subagentType: undefined, childLabel: 'Reply done', toolInput: { description: 'Reply done', prompt: 'reply with done' } },
          { toolUseId: 'toolu_c', toolResult: [{ type: 'text', text: 'task complete' }], toolResultIsError: false },
        )}
      />,
    )
    expect(container.textContent).toContain('default agent')
    expect(container.textContent).toContain('Reply done')
    // collapsed — prompt + result hidden
    expect(container.textContent).not.toContain('reply with done')
    expect(container.textContent).not.toContain('task complete')

    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('reply with done')
    expect(container.textContent).toContain('task complete')
  })

  it('uses subagentType as the label when present', () => {
    const { container } = render(
      <DelegateCall item={item({ toolKind: 'delegate', subagentType: 'Explore', childLabel: 'Do research', toolInput: { description: 'Do research', prompt: 'go', subagent_type: 'Explore' } })} />,
    )
    expect(container.textContent).toContain('Explore')
    expect(container.textContent).toContain('Do research')
  })
})

// ─── Pending (result not yet arrived) ─────────────────────────────────────────

describe('pending tool call', () => {
  it('shows the running… badge and has no expandable detail', () => {
    render(<CommandCall item={item({ toolKind: 'command', toolUseId: 't', toolInput: { command: 'sleep 1' } })} />)
    expect(screen.getByTestId('tool-command').textContent).toContain('running…')
    // No detail to reveal — the summary button is disabled, no output present.
    const button = screen.getByRole('button')
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('aria-expanded')).toBeNull()
  })
})

// ─── Error styling (tri-state) ────────────────────────────────────────────────

describe('error styling', () => {
  it('toolResultIsError === true applies red styling', () => {
    render(
      <CommandCall item={item({ toolKind: 'command', toolUseId: 't', toolInput: { command: 'boom' } }, { toolUseId: 't', toolResult: 'nope', toolResultIsError: true })} />,
    )
    expect(screen.getByTestId('tool-command').className).toContain('border-[var(--red)]/50')
  })

  it('toolResultIsError false / undefined does NOT apply error styling', () => {
    const { rerender } = render(
      <CommandCall item={item({ toolKind: 'command', toolUseId: 't', toolInput: { command: 'ok' } }, { toolUseId: 't', toolResult: 'fine', toolResultIsError: false })} />,
    )
    expect(screen.getByTestId('tool-command').className).not.toContain('var(--red)')
    expect(screen.getByTestId('tool-command').className).toContain('border-[var(--border)]')

    rerender(
      <CommandCall item={item({ toolKind: 'command', toolUseId: 't', toolInput: { command: 'ok' } }, { toolUseId: 't', toolResult: 'fine' })} />,
    )
    expect(screen.getByTestId('tool-command').className).not.toContain('var(--red)')
  })
})

// ─── Reduced motion ───────────────────────────────────────────────────────────

describe('reduced motion', () => {
  it('renders + expands without crashing under reducedMotion="always"', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MotionConfig reducedMotion="always">
        <CommandCall item={item({ toolKind: 'command', toolUseId: 't', toolInput: { command: 'ls' } }, { toolUseId: 't', toolResult: 'reduced-output' })} />
      </MotionConfig>,
    )
    expect(container.textContent).toContain('ls')
    await user.click(screen.getByRole('button'))
    expect(container.textContent).toContain('reduced-output')
  })
})
