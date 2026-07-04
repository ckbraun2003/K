import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { linkify } from '../src/lib/linkify'

afterEach(() => cleanup())

describe('linkify (F-079)', () => {
  it('renders a GitHub PR URL as an anchor opening in a new tab', () => {
    render(<div>{linkify('PR #3 opened: https://github.com/acme/repo/pull/3')}</div>)
    const a = screen.getByRole('link')
    expect(a.getAttribute('href')).toBe('https://github.com/acme/repo/pull/3')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noreferrer')
    expect(a.textContent).toBe('https://github.com/acme/repo/pull/3')
  })

  it('keeps trailing sentence punctuation out of the link', () => {
    render(<div>{linkify('see https://example.com/run.')}</div>)
    const a = screen.getByRole('link')
    expect(a.getAttribute('href')).toBe('https://example.com/run')
  })

  it('linkifies multiple URLs and preserves the surrounding text', () => {
    const { container } = render(
      <div>{linkify('a https://a.com and b http://b.org done')}</div>,
    )
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(container.textContent).toBe('a https://a.com and b http://b.org done')
  })

  it('returns plain text unchanged when there is no URL', () => {
    const { container } = render(<div>{linkify('just a plain line')}</div>)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('just a plain line')
  })
})
