/**
 * ArtifactsTab — W5a behavioral fixes:
 *   F-038: a PROJECT surface lists ONLY its own artifacts (project-<id>-*); the harness's
 *          global ui-demo / project-bible are excluded.
 *   F-029/F-030/F-035: a bible is edited by SECTION — Save calls saveSection (source
 *          write-back + recompile), NEVER the whole-md save, and shows a success toast.
 *   F-035 (generalized): a regular artifact save passes its title/tags through so the
 *          rail row isn't clobbered to the bare slug.
 * api is fully mocked (vi.hoisted), mirroring tasks-tab.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Artifact } from '@k/shared'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion (Toast)
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

const { mockList, mockGet, mockSections, mockSave, mockSaveSection, mockCompileBible, mockProjectsCompile } =
  vi.hoisted(() => ({
    mockList: vi.fn(),
    mockGet: vi.fn(),
    mockSections: vi.fn(),
    mockSave: vi.fn(),
    mockSaveSection: vi.fn(),
    mockCompileBible: vi.fn(),
    mockProjectsCompile: vi.fn(),
  }))

vi.mock('../src/lib/api', () => ({
  api: {
    artifacts: {
      list: mockList,
      get: mockGet,
      sections: mockSections,
      save: mockSave,
      saveSection: mockSaveSection,
      compileBible: mockCompileBible,
    },
    projects: { compileBible: mockProjectsCompile },
  },
}))

import ArtifactsTab from '../src/pages/tabs/ArtifactsTab'

type Meta = Omit<Artifact, 'md' | 'html'>
function meta(slug: string, tags: string[], title: string): Meta {
  return { slug, title, tags, updatedAt: 0 }
}

function renderTab(projectId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ArtifactsTab projectId={projectId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockList.mockReset(); mockGet.mockReset(); mockSections.mockReset()
  mockSave.mockReset(); mockSaveSection.mockReset(); mockCompileBible.mockReset(); mockProjectsCompile.mockReset()
  // DocViewer (rendered for the active artifact) reads api.artifacts.get.
  mockGet.mockResolvedValue({ slug: 'x', title: 'Doc Viewer', tags: [], updatedAt: 0, md: 'body', html: '<p>body</p>' })
  mockSaveSection.mockResolvedValue({ slug: 'project-p1-bible', section: '01-vision', compiledAt: 1 })
  mockSave.mockResolvedValue({ slug: 'x', updatedAt: 1 })
})
afterEach(() => cleanup())

describe('ArtifactsTab — F-038 per-project scoping', () => {
  it('a project surface lists only its own project-<id>-* artifacts', async () => {
    mockList.mockResolvedValue([
      meta('project-bible', ['bible'], 'K Bible'),           // harness global — excluded
      meta('ui-demo', ['ui'], 'K UI Demo'),                  // harness global — excluded
      meta('project-p1-bible', ['bible'], 'P1 Bible'),       // mine
      meta('project-p1-ui-demo', ['ui'], 'P1 UI'),           // mine
      meta('project-p2-bible', ['bible'], 'P2 Bible'),       // another project — excluded
    ])
    renderTab('p1')

    // Mine present (rail + edit dropdown).
    await waitFor(() => expect(screen.getAllByText('P1 Bible').length).toBeGreaterThan(0))
    expect(screen.getAllByText('P1 UI').length).toBeGreaterThan(0)
    // Cross-scope globals + other projects absent everywhere.
    expect(screen.queryByText('K UI Demo')).toBeNull()
    expect(screen.queryByText('K Bible')).toBeNull()
    expect(screen.queryByText('P2 Bible')).toBeNull()
  })
})

describe('ArtifactsTab — bible edited by section (F-029/F-030/F-035)', () => {
  it('editing a bible saves the SECTION (not whole md) and shows a success toast', async () => {
    mockList.mockResolvedValue([meta('project-p1-bible', ['bible'], 'P1 Bible')])
    mockSections.mockResolvedValue({
      sections: [
        { slug: '01-vision', title: 'Vision', icon: '◈', status: 'stable', updated: 'x', body: 'orig body' },
        { slug: '02-roadmap', title: 'Roadmap', icon: '▦', status: 'active', updated: 'x', body: 'roadmap body' },
      ],
    })
    renderTab('p1')

    // Open the editor for the bible via the toolbar select.
    const editSelect = await screen.findByTestId('artifact-edit-select')
    fireEvent.change(editSelect, { target: { value: 'project-p1-bible' } })

    // Section editor loads the section bodies.
    const textarea = await screen.findByTestId('artifact-editor-textarea')
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('orig body'))
    expect(mockSections).toHaveBeenCalledWith('project-p1-bible')

    // Edit the body and save.
    fireEvent.change(textarea, { target: { value: 'edited body' } })
    fireEvent.click(screen.getByTestId('artifact-save-btn'))

    await waitFor(() => expect(mockSaveSection).toHaveBeenCalledWith('project-p1-bible', '01-vision', 'edited body'))
    // The whole-md save (which would be lost on recompile) is NEVER used for a bible.
    expect(mockSave).not.toHaveBeenCalled()

    // Success confirmation (F-035).
    const toast = await screen.findByTestId('artifact-saved-toast')
    expect(toast.textContent).toContain('recompiled')
  })

  it('switching the section dropdown loads that section body', async () => {
    mockList.mockResolvedValue([meta('project-p1-bible', ['bible'], 'P1 Bible')])
    mockSections.mockResolvedValue({
      sections: [
        { slug: '01-vision', title: 'Vision', icon: '◈', status: 'stable', updated: 'x', body: 'orig body' },
        { slug: '02-roadmap', title: 'Roadmap', icon: '▦', status: 'active', updated: 'x', body: 'roadmap body' },
      ],
    })
    renderTab('p1')
    fireEvent.change(await screen.findByTestId('artifact-edit-select'), { target: { value: 'project-p1-bible' } })
    const textarea = await screen.findByTestId('artifact-editor-textarea')
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('orig body'))

    fireEvent.change(screen.getByTestId('bible-section-select'), { target: { value: '02-roadmap' } })
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('roadmap body'))
  })
})

describe('ArtifactsTab — regular artifact save keeps its title/tags (F-035)', () => {
  it('a non-bible save passes the loaded title + tags through', async () => {
    mockList.mockResolvedValue([meta('project-p1-notes', ['doc'], 'P1 Notes')])
    mockGet.mockResolvedValue({
      slug: 'project-p1-notes', title: 'P1 Notes', tags: ['doc'], updatedAt: 0, md: 'note md', html: '<p>note</p>',
    })
    renderTab('p1')

    fireEvent.change(await screen.findByTestId('artifact-edit-select'), { target: { value: 'project-p1-notes' } })
    const textarea = await screen.findByTestId('artifact-editor-textarea')
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('note md'))

    fireEvent.change(textarea, { target: { value: 'updated note' } })
    fireEvent.click(screen.getByTestId('artifact-save-btn'))

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave).toHaveBeenCalledWith('project-p1-notes', expect.objectContaining({
      md: 'updated note', title: 'P1 Notes', tags: ['doc'],
    }))
    expect(mockSaveSection).not.toHaveBeenCalled()
  })
})
