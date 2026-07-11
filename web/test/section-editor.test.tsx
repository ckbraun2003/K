/**
 * P4 E-30 — SectionEditor edit-in-place. Drives the EXISTING section-write API
 * (api.artifacts.sections / api.artifacts.saveSection): pick a section, edit its body,
 * save → the write lands with the right args and a "recompiled" confirmation appears.
 * For a non-bible artifact (sections: []) the editor renders nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BibleSectionView } from '../src/lib/api'

const { mockSections, mockSaveSection } = vi.hoisted(() => ({
  mockSections: vi.fn(),
  mockSaveSection: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { artifacts: { sections: mockSections, saveSection: mockSaveSection } },
}))
import SectionEditor from '../src/components/SectionEditor'

const two: BibleSectionView[] = [
  { slug: '01-intro', title: 'Intro', icon: '', status: '', updated: '', body: 'intro body' },
  { slug: '02-arch', title: 'Arch', icon: '', status: '', updated: '', body: 'arch body' },
]

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SectionEditor slug="project-bible" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockSections.mockReset()
  mockSaveSection.mockReset()
})
afterEach(() => cleanup())

describe('SectionEditor (P4 E-30)', () => {
  it('picks a section, edits the body, saves via saveSection, and shows a recompiled confirmation', async () => {
    mockSections.mockResolvedValue({ sections: two })
    mockSaveSection.mockResolvedValue({ slug: 'project-bible', section: '02-arch', compiledAt: 1700000000000 })

    renderEditor()
    await screen.findByTestId('section-editor')

    // Pick the second section — its body seeds the textarea.
    fireEvent.change(screen.getByTestId('section-editor-select'), { target: { value: '02-arch' } })
    const body = (await screen.findByTestId('section-editor-body')) as HTMLTextAreaElement
    expect(body.value).toBe('arch body')

    // Edit and save.
    fireEvent.change(body, { target: { value: 'arch body EDITED' } })
    fireEvent.click(screen.getByTestId('section-editor-save'))

    await waitFor(() => expect(mockSaveSection).toHaveBeenCalledWith('project-bible', '02-arch', 'arch body EDITED'))
    await waitFor(() => expect(screen.getByTestId('section-editor').textContent).toContain('recompiled'))
  })

  it('renders nothing for a non-bible artifact (sections: [])', async () => {
    mockSections.mockResolvedValue({ sections: [] })

    renderEditor()
    // Let the query settle; the component returns null so the container never appears.
    await waitFor(() => expect(mockSections).toHaveBeenCalled())
    expect(screen.queryByTestId('section-editor')).toBeNull()
  })
})
