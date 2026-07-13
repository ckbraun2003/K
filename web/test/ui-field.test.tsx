import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Input, Textarea, Select } from '../src/ui/Field'

describe('Field', () => {
  it('marks invalid fields for AT and styling', () => {
    render(<Input invalid aria-label="name" />)
    expect(screen.getByLabelText('name').getAttribute('aria-invalid')).toBe('true')
  })
  it('renders textarea and select with the shared skin', () => {
    render(<><Textarea aria-label="notes" /><Select aria-label="model"><option>a</option></Select></>)
    expect(screen.getByLabelText('notes').className).toContain('rounded-control')
    expect(screen.getByLabelText('model').className).toContain('rounded-control')
  })
  it('omits aria-invalid entirely when not invalid', () => {
    render(<Input aria-label="plain" />)
    expect(screen.getByLabelText('plain').hasAttribute('aria-invalid')).toBe(false)
  })
  it('merges caller className over the skin via cn/tailwind-merge', () => {
    render(<Input aria-label="padded" className="px-4" />)
    const cls = screen.getByLabelText('padded').className
    expect(cls).toContain('px-4')
    expect(cls).not.toContain('px-3')
  })
})
