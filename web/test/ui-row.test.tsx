import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Row } from '../src/ui/Row'

afterEach(() => cleanup())

describe('Row', () => {
  it('is a keyboard-activatable button when onClick is set', () => {
    const fn = vi.fn()
    render(<Row testid="r" title="run one" onClick={fn} />)
    const row = screen.getByTestId('r')
    expect(row.getAttribute('role')).toBe('button')
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.click(row)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  // [pins literal classes] — the hover-affordance regression the 2026-07-14
  // audit found (zero hover: classes on Runs rows) is guarded by pinning the
  // literal hover class, per the sidebar-badge house pattern.
  it('carries hover elevation and reveal-on-hover action classes', () => {
    render(<Row testid="r" title="t" onClick={() => {}} actions={<button>kill</button>} />)
    const row = screen.getByTestId('r')
    expect(row.className).toContain('hover:bg-surface')
    const actions = screen.getByText('kill').parentElement!
    expect(actions.className).toContain('group-hover:opacity-100')
    expect(actions.className).toContain('focus-within:opacity-100')
  })
  it('renders leading, sub, and meta slots', () => {
    render(<Row title="t" sub="secondary" leading={<i data-testid="lead" />} meta={<span>4s</span>} />)
    expect(screen.getByTestId('lead')).toBeTruthy()
    expect(screen.getByText('secondary')).toBeTruthy()
    expect(screen.getByText('4s')).toBeTruthy()
  })
  it('marks the selected row', () => {
    render(<Row testid="r" title="t" selected onClick={() => {}} />)
    expect(screen.getByTestId('r').className).toContain('border-l-accent')
  })
})
