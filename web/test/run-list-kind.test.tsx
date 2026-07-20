/**
 * RunList chat-turn visibility (A.3, D-127): the default runs list EXCLUDES
 * chat-turn runs via the server-side kind filter (kind=job,pipeline-stage);
 * the "Show chat turns" toggle refetches WITHOUT the param (all kinds).
 *
 * Stubs global fetch (REAL api module, unlike run-list-filter's api mock) so the
 * assertions cover the actual query string the server receives — including the
 * comma-join api.runs.list builds from the kind array.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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

describe('RunList hides chat turns by default (A.3, D-127)', () => {
  it('the default fetch passes kind=job,pipeline-stage', async () => {
    renderList()
    await waitFor(() => expect(runUrls().length).toBeGreaterThan(0))
    const url = runUrls().at(-1)!
    expect(url).toContain('kind=job,pipeline-stage')
    expect(url).toContain('limit=100')
  })

  it('toggling "Show chat turns" refetches WITHOUT the kind param', async () => {
    renderList()
    await waitFor(() => expect(runUrls().length).toBeGreaterThan(0))

    fireEvent.click(screen.getByTestId('run-show-chat-turns'))

    await waitFor(() => {
      const url = runUrls().at(-1)!
      expect(url).not.toContain('kind=')
    })
    // Still the shared default limit — only the kind scope changed.
    expect(runUrls().at(-1)!).toContain('limit=100')
  })
})
