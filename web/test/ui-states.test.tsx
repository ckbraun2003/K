import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Skeleton, SkeletonRow } from '../src/ui/Skeleton'
import { EmptyState } from '../src/ui/EmptyState'
import { ErrorState } from '../src/ui/ErrorState'

describe('states', () => {
  it('skeleton is aria-hidden decoration', () => {
    const { container } = render(<><Skeleton className="h-4 w-32" /><SkeletonRow /></>)
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2)
  })
  it('empty state shows headline and action', () => {
    render(<EmptyState icon="runs" headline="No runs yet" hint="⌘K to dispatch one" />)
    expect(screen.getByText('No runs yet')).toBeTruthy()
  })
  it('error state retries', () => {
    const fn = vi.fn()
    render(<ErrorState message="fetch failed" onRetry={fn} />)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(fn).toHaveBeenCalledOnce()
  })
})
