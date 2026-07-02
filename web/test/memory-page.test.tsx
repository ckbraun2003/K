import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MemoryLesson } from '../src/lib/memory'

const { mockLessons } = vi.hoisted(() => ({ mockLessons: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: {
    memory: {
      lessons: mockLessons,
      approve: vi.fn(async () => ({})),
      reject: vi.fn(async () => ({})),
    },
  },
}))

import MemoryPage, { LessonCard } from '../src/pages/MemoryPage'

// jsdom has no matchMedia; framer-motion may probe it. Provide an inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => cleanup())

// ── Factory ──────────────────────────────────────────────────────────────────

function lesson(over: Partial<MemoryLesson> = {}): MemoryLesson {
  return {
    id: 'les-1',
    runId: 'run-abcdef123456',
    profileId: 'prof-1',
    profileName: 'K',
    lesson: 'Always run typecheck before committing.',
    status: 'pending',
    createdAt: Date.now() - 60_000,
    reviewedAt: null,
    ...over,
  }
}

// ── LessonCard ─────────────────────────────────────────────────────────────────

describe('LessonCard', () => {
  it('renders the lesson text and proposing profile name', () => {
    render(<LessonCard lesson={lesson()} onApprove={() => {}} onReject={() => {}} />)
    const card = screen.getByTestId('memory-lesson-les-1')
    expect(card.textContent).toContain('Always run typecheck before committing.')
    expect(card.textContent).toContain('K') // profileName
    expect(card.textContent).toContain('run-abcd') // short run id
  })

  it('falls back to "unassigned" / "no run" for a lesson with no profile or run', () => {
    render(<LessonCard lesson={lesson({ profileName: null, runId: null })} onApprove={() => {}} onReject={() => {}} />)
    const card = screen.getByTestId('memory-lesson-les-1')
    expect(card.textContent).toContain('unassigned')
    expect(card.textContent).toContain('no run')
  })

  it('invokes onApprove with the lesson id when Approve is clicked', () => {
    const onApprove = vi.fn()
    render(<LessonCard lesson={lesson()} onApprove={onApprove} onReject={() => {}} />)
    fireEvent.click(screen.getByTestId('memory-approve-les-1'))
    expect(onApprove).toHaveBeenCalledWith('les-1')
  })

  it('invokes onReject with the lesson id when Reject is clicked', () => {
    const onReject = vi.fn()
    render(<LessonCard lesson={lesson()} onApprove={() => {}} onReject={onReject} />)
    fireEvent.click(screen.getByTestId('memory-reject-les-1'))
    expect(onReject).toHaveBeenCalledWith('les-1')
  })

  it('renders a read-only history card (no action buttons) when no callbacks are supplied', () => {
    render(<LessonCard lesson={lesson({ status: 'accepted', reviewedAt: Date.now() })} />)
    expect(screen.getByTestId('memory-lesson-les-1')).toBeTruthy()
    expect(screen.queryByTestId('memory-approve-les-1')).toBeNull()
    expect(screen.queryByTestId('memory-reject-les-1')).toBeNull()
  })
})

// ── MemoryPage — the proposing-profile filter (C2) ─────────────────────────────

const allPending: MemoryLesson[] = [
  lesson({ id: 'l1', profileId: 'prof-k', profileName: 'K', lesson: 'lesson from K' }),
  lesson({ id: 'l2', profileId: 'prof-be', profileName: 'Backend', lesson: 'lesson from Backend' }),
  // A pre-A1 row with no proposing profile — must NOT become a filter option.
  lesson({ id: 'l3', profileId: null, profileName: null, lesson: 'orphan lesson' }),
]

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryPage />
    </QueryClientProvider>,
  )
}

describe('MemoryPage — profile filter', () => {
  beforeEach(() => {
    mockLessons.mockReset()
    mockLessons.mockImplementation(async (opts?: { status?: string; profileId?: string }) =>
      opts?.profileId != null
        ? allPending.filter(l => l.profileId === opts.profileId)
        : allPending,
    )
  })

  it('renders the filter with All profiles + one option per distinct proposing profile', async () => {
    renderPage()
    const select = (await screen.findByTestId('memory-profile-filter')) as HTMLSelectElement
    // Wait for the unfiltered list to arrive and feed the options.
    await waitFor(() => expect(select.options.length).toBe(3))
    const labels = [...select.options].map(o => o.textContent)
    expect(labels).toEqual(['All profiles', 'K', 'Backend'])
  })

  it('selecting a profile re-queries server-side with ?profileId and narrows the list', async () => {
    renderPage()
    await screen.findByTestId('memory-lesson-l1')
    const select = (await screen.findByTestId('memory-profile-filter')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))

    fireEvent.change(select, { target: { value: 'prof-be' } })

    // The FILTERED fetch went to the server (not a client-side filter)…
    await waitFor(() =>
      expect(mockLessons).toHaveBeenCalledWith({ status: 'pending', profileId: 'prof-be' }),
    )
    // …and only the Backend lesson remains rendered.
    await waitFor(() => expect(screen.queryByTestId('memory-lesson-l1')).toBeNull())
    expect(screen.getByTestId('memory-lesson-l2')).toBeTruthy()

    // The options stay fed by the UNFILTERED result — picking one profile must not
    // collapse the select to just itself.
    expect(select.options.length).toBe(3)
  })
})
