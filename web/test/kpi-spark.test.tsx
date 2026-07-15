/** FE-4 systemic #4 — KpiTile grows an optional sparkline + a period micro-label.
 *  No fabricated trend: an absent or all-zero spark renders no svg at all. */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { KpiTile } from '../src/ui/KpiTile'

afterEach(() => cleanup())

describe('KpiTile spark + period', () => {
  it('renders a sparkline polyline when spark has signal', () => {
    const { container } = render(<KpiTile label="Cost" value="$2.08" spark={[0.1, 0.4, 0.2, 0.9]} />)
    expect(container.querySelector('polyline')).toBeTruthy()
  })
  it('renders no svg for absent or all-zero spark (no fabricated trend)', () => {
    const { container, rerender } = render(<KpiTile label="Cost" value="$0" />)
    expect(container.querySelector('polyline')).toBeNull()
    rerender(<KpiTile label="Cost" value="$0" spark={[0, 0, 0]} />)
    expect(container.querySelector('polyline')).toBeNull()
  })
  it('renders the period micro-label', () => {
    const { getByText } = render(<KpiTile label="Runs" value="12" period="14D" />)
    expect(getByText('14D')).toBeTruthy()
  })
})
