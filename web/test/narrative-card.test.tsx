/** P3 A2 - NarrativeCard renders deterministic fields always; bullets are labeled + degrade. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NarrativeCard from '../src/components/NarrativeCard'

const { mockNarrative } = vi.hoisted(() => ({ mockNarrative: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { runs: { narrative: mockNarrative } } }))

const base = {
  runId: '11111111-2222-4333-8444-555555555555',
  goal: 'Create hello.js that prints hello',
  outcome: { status: 'done', endedAt: 1600, durationMs: 600 },
  files: ['hello.js', 'README.md'],
  verification: { status: 'pass', reason: null, commandCount: 2 },
  cost: { costUsd: 0.0031, tokensIn: 1200, tokensOut: 340 },
  bullets: null, bulletsState: 'unavailable',
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><NarrativeCard runId={base.runId} /></QueryClientProvider>)
}
afterEach(() => { cleanup(); localStorage.clear() })
beforeEach(() => mockNarrative.mockReset())

describe('NarrativeCard', () => {
  it('renders deterministic fields and the degrade note when bullets are unavailable', async () => {
    mockNarrative.mockResolvedValue(base)
    renderCard()
    expect(await screen.findByText(/Create hello.js/)).toBeTruthy()
    // NOTE: the goal text ("Create hello.js that prints hello") and the joined
    // files field ("hello.js, README.md") both contain the literal substring
    // "hello.js", so a getByText(/hello.js/) single-match query is genuinely
    // ambiguous against the frozen component's rendering. Assert on
    // "README.md" instead — unique to the files field — to keep the same
    // intent (files field is rendered) without an inherent collision.
    expect(screen.getByText(/README.md/)).toBeTruthy()
    expect(screen.getByTestId('narrative-bullets-note').textContent).toMatch(/unavailable|skipped/i)
    expect(screen.queryByTestId('narrative-bullets')).toBeNull()
  })
  it('renders labeled generated bullets when bulletsState is ok', async () => {
    mockNarrative.mockResolvedValue({ ...base, bulletsState: 'ok',
      bullets: { decisions: ['chose fs.writeFile'], risks: ['no tests added'], generated: true, model: 'qwen2.5' } })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('narrative-bullets')).toBeTruthy())
    expect(screen.getByText(/chose fs.writeFile/)).toBeTruthy()
    expect(screen.getByText(/no tests added/)).toBeTruthy()
    expect(screen.getByTestId('narrative-bullets').textContent).toMatch(/generated/i)
    expect(screen.getByTestId('narrative-bullets').textContent).toMatch(/qwen2.5/)
  })
  it('shows honest fallbacks when verification is null and no files are recorded', async () => {
    mockNarrative.mockResolvedValue({ ...base, verification: null, files: [] })
    renderCard()
    await screen.findByTestId('narrative-card')
    expect(screen.getByTestId('narrative-verify').textContent).toMatch(/not run/i)
    expect(screen.getByText(/none recorded/i)).toBeTruthy()
  })
})

// Lane B (ui-adjustments Round 2): collapsible header, persisted per-run in localStorage.
describe('NarrativeCard collapse (Lane B, ui-adjustments Round 2)', () => {
  it('is expanded by default and the chevron toggle hides/shows the body', async () => {
    mockNarrative.mockResolvedValue(base)
    renderCard()
    await screen.findByTestId('narrative-card')
    expect(screen.getByTestId('narrative-goal')).toBeTruthy()

    fireEvent.click(screen.getByTestId('narrative-collapse-toggle'))
    expect(screen.queryByTestId('narrative-goal')).toBeNull()
    // Header (title + status pill) stays visible while collapsed.
    expect(screen.getByText('Run narrative')).toBeTruthy()

    fireEvent.click(screen.getByTestId('narrative-collapse-toggle'))
    expect(screen.getByTestId('narrative-goal')).toBeTruthy()
  })

  it('persists the collapsed state per-run in localStorage and restores it on remount', async () => {
    mockNarrative.mockResolvedValue(base)
    const { unmount } = renderCard()
    await screen.findByTestId('narrative-card')

    fireEvent.click(screen.getByTestId('narrative-collapse-toggle'))
    expect(localStorage.getItem(`narrative-collapsed:${base.runId}`)).toBe('1')
    unmount()

    renderCard()
    await screen.findByTestId('narrative-card')
    expect(screen.queryByTestId('narrative-goal')).toBeNull()
  })

  it('a different runId does not inherit another run\'s collapsed state', async () => {
    localStorage.setItem(`narrative-collapsed:${base.runId}`, '1')
    mockNarrative.mockResolvedValue(base)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <NarrativeCard runId="other-run-id" />
      </QueryClientProvider>,
    )
    await screen.findByTestId('narrative-card')
    expect(screen.getByTestId('narrative-goal')).toBeTruthy()
  })

  // The regression the [runId] useEffect exists to prevent: RunConsole keeps ONE
  // persistent <NarrativeCard> across a run switch (no remount), so a live runId
  // prop change — not a fresh mount — must re-derive collapsed from the new key.
  // Without the effect, run A's collapsed=true leaks onto run B and the body stays
  // hidden. (The fresh-mount test above passes even with the effect deleted.)
  it('re-derives collapsed from the new key on a live runId change (persistent instance)', async () => {
    const runA = base.runId
    const runB = 'bbbbbbbb-2222-4333-8444-555555555555'
    localStorage.setItem(`narrative-collapsed:${runA}`, '1') // A collapsed; B has no key → expanded
    mockNarrative.mockResolvedValue(base)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}><NarrativeCard runId={runA} /></QueryClientProvider>,
    )
    await screen.findByTestId('narrative-card')
    expect(screen.queryByTestId('narrative-goal')).toBeNull() // A is collapsed

    rerender(<QueryClientProvider client={qc}><NarrativeCard runId={runB} /></QueryClientProvider>)
    await waitFor(() => expect(screen.getByTestId('narrative-goal')).toBeTruthy()) // B re-derived → expanded
  })
})
