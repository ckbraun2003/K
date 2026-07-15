import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EmptyState } from '../src/ui/EmptyState'

afterEach(() => cleanup())

describe('EmptyState extension', () => {
  it('renders a primary CTA button that fires onClick', () => {
    const fn = vi.fn()
    render(<EmptyState icon="runs" headline="No runs yet" cta={{ label: 'Dispatch one', onClick: fn }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch one' }))
    expect(fn).toHaveBeenCalledOnce()
  })
  it('renders the illustration slot in place of the icon bubble', () => {
    const { container } = render(
      <EmptyState icon="check" headline="All caught up" illustration={<svg data-testid="illo" />} />,
    )
    expect(screen.getByTestId('illo')).toBeTruthy()
    expect(container.querySelector('.glass-panel')).toBeNull() // no doubled icon bubble
  })
  it('keeps the legacy action slot working alongside cta', () => {
    render(<EmptyState icon="runs" headline="h" cta={{ label: 'Go', onClick: () => {} }} action={<a href="#/docs">docs</a>} />)
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
    expect(screen.getByText('docs')).toBeTruthy()
  })
})
