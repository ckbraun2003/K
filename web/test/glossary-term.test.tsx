// web/test/glossary-term.test.tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import GlossaryTerm from '../src/components/GlossaryTerm'

afterEach(() => cleanup())

describe('GlossaryTerm', () => {
  it('shows the definition on hover for a known term', () => {
    render(<GlossaryTerm term="Wave">wave</GlossaryTerm>)
    fireEvent.mouseEnter(screen.getByTestId('glossary-term'))
    expect(screen.getByRole('tooltip').textContent).toMatch(/reviewable commit/i)
  })
  it('renders children plainly for an unknown term (no affordance)', () => {
    render(<GlossaryTerm term="NotARealTerm">plain</GlossaryTerm>)
    expect(screen.queryByTestId('glossary-term')).toBeNull()
    expect(screen.getByText('plain')).toBeTruthy()
  })
})
