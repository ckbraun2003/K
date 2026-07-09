/**
 * RunList "active" filter (F-055): a parked (awaiting_input) run holds a live CLI
 * process needing operator attention, so the "active" chip must count it and the
 * filtered list must include it — a parked run must not read as inactive.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run } from '@k/shared'

const { runsRef } = vi.hoisted(() => ({ runsRef: { current: [] as Run[] } }))

vi.mock('../src/lib/api', () => ({ api: { runs: { list: async () => runsRef.current, kill: vi.fn() } } }))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

import RunList from '../src/components/RunList'

const makeRun = (over: Partial<Run>): Run => ({
  id: over.id ?? 'r', prompt: over.prompt ?? 'a run', cwd: '/repo', status: 'done',
  provider: 'claude', model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: 0, ...over,
})

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => { cleanup(); runsRef.current = [] })

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunList selectedId={null} onSelect={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('RunList active filter includes parked runs (F-055)', () => {
  it('counts an awaiting_input run under "active" and shows it when filtered', async () => {
    runsRef.current = [
      makeRun({ id: 'run', status: 'running', prompt: 'live run' }),
      makeRun({ id: 'park', status: 'awaiting_input', prompt: 'parked run needs input' }),
      makeRun({ id: 'done', status: 'done', prompt: 'finished run' }),
    ]
    renderList()

    // active chip counts running + awaiting_input = 2 (not just the running run).
    // Wait for the async query to resolve before asserting the count.
    await waitFor(() => expect(screen.getByTestId('run-filter-active').textContent).toContain('2'))

    fireEvent.click(screen.getByTestId('run-filter-active'))
    expect(screen.getByText('parked run needs input')).toBeTruthy()
    expect(screen.getByText('live run')).toBeTruthy()
    expect(screen.queryByText('finished run')).toBeNull()
  })

  // P2 E-02: awaiting_plan is the OTHER parked flavor (process-dead plan review) —
  // the shared isParkedRun predicate must count it under "active" too.
  it('counts an awaiting_plan run under "active" and shows it when filtered (P2 E-02)', async () => {
    runsRef.current = [
      makeRun({ id: 'run', status: 'running', prompt: 'live run' }),
      makeRun({ id: 'plan', status: 'awaiting_plan', prompt: 'parked on plan review' }),
      makeRun({ id: 'done', status: 'done', prompt: 'finished run' }),
    ]
    renderList()

    await waitFor(() => expect(screen.getByTestId('run-filter-active').textContent).toContain('2'))

    fireEvent.click(screen.getByTestId('run-filter-active'))
    expect(screen.getByText('parked on plan review')).toBeTruthy()
    expect(screen.getByText('live run')).toBeTruthy()
    expect(screen.queryByText('finished run')).toBeNull()
  })
})
