/** P4 W0b — the ONE canonical page-level tab bar. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import Tabs from '../src/components/Tabs'

afterEach(() => cleanup())
type T = 'overview' | 'charts'
const items = [{ value: 'overview' as T, label: 'Overview' }, { value: 'charts' as T, label: 'Charts', count: 9 }]

describe('Tabs', () => {
  it('renders a tablist, marks the active tab aria-selected, and shows counts', () => {
    render(<Tabs<T> items={items} value="overview" onChange={() => {}} ariaLabel="Insights" />)
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Insights')
    expect(screen.getByTestId('tab-overview').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('tab-charts').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('tab-charts').textContent).toContain('9')
  })
  it('fires onChange with the clicked tab value', () => {
    const onChange = vi.fn()
    render(<Tabs<T> items={items} value="overview" onChange={onChange} />)
    fireEvent.click(screen.getByTestId('tab-charts'))
    expect(onChange).toHaveBeenCalledWith('charts')
  })
})
