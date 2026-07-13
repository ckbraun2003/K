import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KpiTile } from '../src/ui/KpiTile'

describe('KpiTile', () => {
  it('colors delta by polarity, not by sign', () => {
    const { rerender } = render(<KpiTile label="Cost" value="$2.08" delta={{ pct: 33, polarity: 'badUp' }} />)
    expect(screen.getByText('+33%').className).toContain('text-red')
    rerender(<KpiTile label="Success" value="46%" delta={{ pct: 42, polarity: 'goodUp' }} />)
    expect(screen.getByText('+42%').className).toContain('text-green')
  })
})
