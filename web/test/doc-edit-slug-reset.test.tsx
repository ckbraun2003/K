/**
 * P4 C2 regression (quality-review BLOCKER): switching the DocViewer to a DIFFERENT
 * artifact while Edit is on must FULLY RESET the section editor. Bibles share a section-slug
 * convention, so without a `key={slug}` remount the stale picked section + edited draft would
 * survive the switch and a Save could write bible-A's draft into bible-B's section (silent
 * cross-artifact data loss). This asserts the edited textarea is gone after the slug flips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockGet, mockSections, mockSaveSection } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSections: vi.fn(),
  mockSaveSection: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { artifacts: { get: mockGet, sections: mockSections, saveSection: mockSaveSection } },
}))
import DocViewer from '../src/components/DocViewer'

beforeEach(() => {
  mockGet.mockReset()
  mockSections.mockReset()
  mockSaveSection.mockReset()
  mockGet.mockImplementation((slug: string) =>
    Promise.resolve({ slug, title: slug, tags: [], updatedAt: 0, md: `# ${slug}`, html: `<html><body>${slug}</body></html>` }))
  // Both bibles expose the SAME section slug (the shared convention) with different bodies.
  mockSections.mockImplementation((slug: string) =>
    Promise.resolve({ sections: [{ slug: '02-arch', title: 'Arch', icon: '', status: '', updated: '', body: slug === 'bible-a' ? 'A body' : 'B body' }] }))
})
afterEach(() => cleanup())

function renderViewer(slug: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <DocViewer slug={slug} />
    </QueryClientProvider>,
  )
  return { qc, ...utils }
}

describe('DocViewer edit-in-place — artifact switch resets the editor', () => {
  it('an unsaved edit on bible-a does NOT survive a switch to bible-b (key={slug} remount)', async () => {
    const { qc, rerender } = renderViewer('bible-a')

    // Turn Edit on, pick the section, edit its body.
    fireEvent.click(await screen.findByTestId('doc-edit-toggle'))
    await screen.findByTestId('section-editor')
    fireEvent.change(screen.getByTestId('section-editor-select'), { target: { value: '02-arch' } })
    const body = (await screen.findByTestId('section-editor-body')) as HTMLTextAreaElement
    expect(body.value).toBe('A body')
    fireEvent.change(body, { target: { value: 'A EDITED' } })

    // Switch to a DIFFERENT artifact (Edit stays on).
    rerender(
      <QueryClientProvider client={qc}>
        <DocViewer slug="bible-b" />
      </QueryClientProvider>,
    )

    // The editor re-mounts fresh for bible-b: no section picked → no draft textarea.
    await waitFor(() => expect(screen.getByTestId('section-editor-select')).toBeTruthy())
    expect(screen.queryByTestId('section-editor-body')).toBeNull()
    // And the stale draft is nowhere in the DOM.
    expect(screen.queryByDisplayValue('A EDITED')).toBeNull()
  })
})
