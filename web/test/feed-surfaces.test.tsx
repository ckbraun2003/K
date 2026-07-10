/** P3 B2 — TimelinePage renders the feed, filters by kind, and opt-in digest mounts the card. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockFeed, mockNarrative } = vi.hoisted(() => ({ mockFeed: vi.fn(), mockNarrative: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { feed: { list: mockFeed }, runs: { narrative: mockNarrative } } }))
import TimelinePage from '../src/pages/TimelinePage'

const RID = '11111111-2222-4333-8444-555555555555'
const items = [
  { id: 'run:1:done', kind: 'done', ts: 5, runId: RID, runStatus: 'done', projectId: null, projectName: 'proj', title: 'finished work', detail: null },
  { id: 'verify:1:fail', kind: 'verify_fail', ts: 4, runId: RID, runStatus: 'done', projectId: null, projectName: 'proj', title: 'finished work', detail: 'verify failed' },
]
const counts = { dispatch: 0, park: 0, plan_gate: 0, review_ready: 0, pr: 0, merge: 0, verify_pass: 0, verify_fail: 1, failure: 0, done: 1 }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><TimelinePage /></QueryClientProvider>)
}
beforeEach(() => { mockFeed.mockReset(); mockNarrative.mockReset(); mockFeed.mockResolvedValue({ items, counts, total: 2 }) })
afterEach(() => cleanup())

describe('TimelinePage', () => {
  it('renders feed rows', async () => {
    renderPage()
    expect((await screen.findAllByTestId('feed-row')).length).toBe(2)
  })
  it('a kind chip filters the list', async () => {
    renderPage()
    await screen.findAllByTestId('feed-row')
    fireEvent.click(screen.getByTestId('feed-chip-done'))
    await waitFor(() => expect(screen.getAllByTestId('feed-row').length).toBe(1))
  })
  it('digest toggle mounts the narrative slot for terminal run rows', async () => {
    // Assert the DIGEST SLOT — the wrapper that mounts NarrativeCard for done/review_ready
    // rows — appears on toggle.
    renderPage()
    await screen.findAllByTestId('feed-row')
    expect(screen.queryByTestId('feed-digest-card')).toBeNull()
    fireEvent.click(screen.getByTestId('feed-digest-toggle'))
    await waitFor(() => expect(screen.getByTestId('feed-digest-card')).toBeTruthy())
  })
  it('surfaces "showing N of M" when the window holds more than is shown (SEAMS MED-2)', async () => {
    mockFeed.mockResolvedValue({ items, counts, total: 50 })
    renderPage()
    await screen.findAllByTestId('feed-row')
    expect(screen.getByTestId('feed-truncation').textContent).toContain('showing 2 of 50')
  })
  it('no truncation signal when the whole window is shown', async () => {
    renderPage() // total: 2, shown: 2
    await screen.findAllByTestId('feed-row')
    expect(screen.queryByTestId('feed-truncation')).toBeNull()
  })
  it('a kind chip exposes its pressed state to assistive tech (SEAMS LOW-8)', async () => {
    renderPage()
    await screen.findAllByTestId('feed-row')
    const chip = screen.getByTestId('feed-chip-done')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip)
    await waitFor(() => expect(chip.getAttribute('aria-pressed')).toBe('true'))
  })
  it('caps the digest fan-out at 12 mounted cards over a long window (SEAMS MED-1)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `run:${i}:done`, kind: 'done', ts: 100 - i, runId: `run-${i}`,
      runStatus: 'done', projectId: null, projectName: 'proj', title: `work ${i}`, detail: null,
    }))
    mockFeed.mockResolvedValue({ items: many, counts: { ...counts, done: 20, verify_fail: 0 }, total: 20 })
    renderPage()
    await screen.findAllByTestId('feed-row')
    fireEvent.click(screen.getByTestId('feed-digest-toggle'))
    await waitFor(() => expect(screen.getAllByTestId('feed-digest-card').length).toBe(12))
  })
})
