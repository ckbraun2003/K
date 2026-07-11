/** P4 W0b — the canonical segmented single-select (extended SegControl). Backward-compatible
 *  with the {label,value} shape; adds optional ariaLabel/size + per-option icon/count. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import SegControl from '../src/components/SegControl'

afterEach(() => cleanup())
type S = 'roster' | 'tree' | 'graph'
const options = [
  { label: 'Roster', value: 'roster' as S }, { label: 'Tree', value: 'tree' as S },
  { label: 'Graph', value: 'graph' as S, count: 4 },
]

describe('SegControl (extended)', () => {
  it('marks the active segment aria-pressed and honors ariaLabel + per-option count', () => {
    render(<SegControl<S> options={options} value="roster" onChange={() => {}} ariaLabel="Org view" />)
    expect(screen.getByRole('group', { name: 'Org view' })).toBeTruthy()
    expect(screen.getByTestId('seg-roster').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('seg-graph').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('seg-graph').textContent).toContain('4')
  })
  it('fires onChange on click (unchanged behavior)', () => {
    const onChange = vi.fn()
    render(<SegControl<S> options={options} value="roster" onChange={onChange} />)
    fireEvent.click(screen.getByTestId('seg-graph'))
    expect(onChange).toHaveBeenCalledWith('graph')
  })
})
