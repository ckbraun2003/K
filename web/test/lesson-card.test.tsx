/**
 * LessonCard — provenance-line fallback labels (UI Simplification Task 18 follow-up).
 * A lesson proposed with no profile renders 'unassigned' and one with no run renders
 * 'no run' (LessonCard.tsx's `profileName ?? 'unassigned'` / `runId ? slice : 'no run'`).
 * These assertions lived in the retired memory-page.test.tsx; the component (and the
 * behavior) survive in OrchestratorDetailPage's Memory tab, so the coverage returns here.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { MemoryLesson } from '../src/lib/memory'
import { LessonCard } from '../src/components/LessonCard'

function lesson(over: Partial<MemoryLesson> = {}): MemoryLesson {
  return {
    id: 'les-1',
    runId: null,
    profileId: null,
    profileName: null,
    lesson: 'Always wipe the shared vitest data dir before full runs.',
    status: 'pending',
    createdAt: Date.now() - 60_000,
    reviewedAt: null,
    ...over,
  }
}

afterEach(() => cleanup())

describe('LessonCard — provenance fallback labels', () => {
  it('null profileName renders "unassigned" and null runId renders "no run"', () => {
    render(<LessonCard lesson={lesson()} />)
    const card = screen.getByTestId('memory-lesson-les-1')
    expect(card.textContent).toContain('unassigned')
    expect(card.textContent).toContain('no run')
  })

  it('populated profileName/runId render the name and the 8-char run prefix instead', () => {
    render(<LessonCard lesson={lesson({ profileName: 'Frontend', runId: 'run-abcdef1234' })} />)
    const card = screen.getByTestId('memory-lesson-les-1')
    expect(card.textContent).toContain('Frontend')
    expect(card.textContent).toContain('run-abcd') // runId.slice(0, 8)
    expect(card.textContent).not.toContain('unassigned')
    expect(card.textContent).not.toContain('no run')
  })
})
