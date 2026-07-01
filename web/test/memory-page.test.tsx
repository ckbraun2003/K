import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { LessonCard } from '../src/pages/MemoryPage'
import type { MemoryLesson } from '../src/lib/memory'

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
