/**
 * RunList chat-turn visibility (A.3, D-127; Round 2 Lane B: the "Show chat turns"
 * escape hatch is now GONE — chat turns are PERMANENTLY excluded, this is a runs
 * console, not the Messages surface). The list always fetches with the server-side
 * kind filter (kind=job,pipeline-stage); there is no UI path back to unfiltered.
 *
 * Stubs global fetch (REAL api module, unlike run-list-filter's api mock) so the
 * assertions cover the actual query string the server receives — including the
 * comma-join api.runs.list builds from the kind array.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

// Minimal fetch stub: every request resolves 200 [] (RunList only lists here).
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => [],
}))
vi.stubGlobal('fetch', fetchMock)

import RunList from '../src/components/RunList'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => { cleanup(); fetchMock.mockClear() })

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RunList selectedId={null} onSelect={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** Every /api/runs list URL fetched so far (decoded for readable asserts). */
function runUrls(): string[] {
  return fetchMock.mock.calls
    .map(c => decodeURIComponent(String(c[0])))
    .filter(u => u.includes('/api/runs'))
}

describe('RunList permanently hides chat turns (A.3, D-127; Round 2 Lane B)', () => {
  it('the fetch always passes kind=job,pipeline-stage', async () => {
    renderList()
    await waitFor(() => expect(runUrls().length).toBeGreaterThan(0))
    const url = runUrls().at(-1)!
    expect(url).toContain('kind=job,pipeline-stage')
    expect(url).toContain('limit=100')
  })

  it('switching the Active|Archived segment keeps the kind filter — no way to opt back into chat turns', async () => {
    renderList()
    await waitFor(() => expect(runUrls().length).toBeGreaterThan(0))

    fireEvent.click(screen.getByTestId('seg-only'))

    await waitFor(() => expect(runUrls().at(-1)).toContain('archived=only'))
    expect(runUrls().at(-1)).toContain('kind=job,pipeline-stage')
  })

  it('the "Show chat turns" toggle no longer exists', async () => {
    renderList()
    await waitFor(() => expect(runUrls().length).toBeGreaterThan(0))
    expect(screen.queryByTestId('run-show-chat-turns')).toBeNull()
  })
})
