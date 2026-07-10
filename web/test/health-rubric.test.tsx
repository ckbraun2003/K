import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { healthRubric } from '../src/lib/health'
import HealthRubric from '../src/components/HealthRubric'

describe('healthRubric (single source of the health→color mapping)', () => {
  it('canonical thresholds: null/75/50 boundaries', () => {
    expect(healthRubric(null).band).toBe('unknown')
    expect(healthRubric(90).band).toBe('healthy')
    expect(healthRubric(75).band).toBe('healthy')
    expect(healthRubric(74).band).toBe('warn')
    expect(healthRubric(50).band).toBe('warn')
    expect(healthRubric(49).band).toBe('critical')
    // FleetGraph needs a real hex (canvas/svg can't take a Tailwind class):
    expect(healthRubric(90).hex).toMatch(/^#/)
  })
  it('component renders the band and optional score', () => {
    render(<HealthRubric score={80} showScore />)
    expect(screen.getByTestId('health-rubric').textContent).toMatch(/80/)
  })
})
