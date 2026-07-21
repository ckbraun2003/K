/**
 * RunList archive/delete (Lane B, B5 — runs consolidation; rewritten Round 2 for
 * the Active|Archived segmented control). The default list EXCLUDES archived runs
 * via the server-side ?archived=exclude filter; the Active|Archived `SegControl`
 * (testids `seg-exclude`/`seg-only`, see SegControl.tsx) refetches with
 * ?archived=only to show the archived set instead (archived rows carry the muted
 * "Archived" tag). Multi-select checkboxes drive a floating selection popup
 * (Archive/Unarchive toggle, Archive all, Delete permanently via ConfirmDialog);
 * "Clear finished" is a standalone action.
 *
 * Stubs global fetch (REAL api module, like run-list-kind.test.tsx) so the
 * assertions cover the actual query string / endpoint each action hits. No
 * jest-dom matchers in this codebase's vitest setup (see run-list-filter.test.tsx) —
 * presence is `.toBeTruthy()` on a `getBy*`/absence is `.toBeNull()` on `queryBy*`.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))

const ACTIVE = { id: 'run-active-1', prompt: 'active run', cwd: '/tmp', status: 'done', provider: 'claude', model: 'sonnet', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now(), archived: false }
const ARCHIVED = { id: 'run-archived-1', prompt: 'archived run', cwd: '/tmp', status: 'done', provider: 'claude', model: 'sonnet', tokensIn: 0, tokensOut: 0, costUsd: 0, createdAt: Date.now(), archived: true }

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    statusText: status === 204 ? 'No Content' : 'OK',
    headers: { get: (k: string) => (status === 204 && k === 'content-length' ? '0' : null) },
    json: async () => body,
  }
}

const archiveCalls: string[] = []
const unarchiveCalls: string[] = []
const deleteCalls: string[] = []
let clearFinishedCalls = 0

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const u = decodeURIComponent(String(input))
  const method = (init?.method ?? 'GET').toUpperCase()

  if (method === 'GET' && u.includes('/api/runs') && !u.includes('/api/runs/')) {
    const qs = new URLSearchParams(u.split('?')[1] ?? '')
    const mode = qs.get('archived') ?? 'exclude'
    const rows = [ACTIVE, ARCHIVED].filter(r => (mode === 'include' ? true : mode === 'only' ? r.archived : !r.archived))
    return jsonResponse(200, rows)
  }
  const archiveMatch = u.match(/\/api\/runs\/([^/]+)\/archive$/)
  if (method === 'POST' && archiveMatch) {
    archiveCalls.push(archiveMatch[1])
    return jsonResponse(200, { id: archiveMatch[1], archived: true })
  }
  const unarchiveMatch = u.match(/\/api\/runs\/([^/]+)\/unarchive$/)
  if (method === 'POST' && unarchiveMatch) {
    unarchiveCalls.push(unarchiveMatch[1])
    return jsonResponse(200, { id: unarchiveMatch[1], archived: false })
  }
  if (method === 'POST' && u.includes('/api/runs/clear-finished')) {
    clearFinishedCalls++
    return jsonResponse(200, { archivedCount: 2 })
  }
  const deleteMatch = u.match(/\/api\/runs\/([^/]+)$/)
  if (method === 'DELETE' && deleteMatch) {
    deleteCalls.push(deleteMatch[1])
    return jsonResponse(204, undefined)
  }
  return jsonResponse(200, [])
})
vi.stubGlobal('fetch', fetchMock)

import RunList from '../src/components/RunList'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})
afterEach(() => {
  cleanup()
  fetchMock.mockClear()
  archiveCalls.length = 0
  unarchiveCalls.length = 0
  deleteCalls.length = 0
  clearFinishedCalls = 0
})

function renderList(onSelect = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RunList selectedId={null} onSelect={onSelect} />
    </QueryClientProvider>,
  )
  return { onSelect }
}

function runUrls(): string[] {
  return fetchMock.mock.calls
    .map(c => decodeURIComponent(String(c[0])))
    .filter(u => u.includes('/api/runs') && !u.includes('/archive') && !u.includes('/unarchive') && !u.includes('/clear-finished'))
}

describe('RunList archive visibility (Lane B, B5 — Active|Archived segment, Round 2)', () => {
  it('the default fetch passes archived=exclude and hides the archived row', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    expect(runUrls().at(-1)).toContain('archived=exclude')
    expect(screen.queryByText('archived run')).toBeNull()
    // Active is the default-pressed segment.
    expect(screen.getByTestId('seg-exclude').getAttribute('aria-pressed')).toBe('true')
  })

  it('switching to the Archived segment refetches with archived=only and shows the Archived tag', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())

    fireEvent.click(screen.getByTestId('seg-only'))

    await waitFor(() => expect(screen.getByText('archived run')).toBeTruthy())
    expect(runUrls().at(-1)).toContain('archived=only')
    expect(screen.queryByText('active run')).toBeNull()
    expect(screen.getByTestId('run-archived-tag')).toBeTruthy()
  })

  it('there is no escape hatch back to an "include both" view — only exclude/only segments exist', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    expect(screen.queryByTestId('run-show-archived')).toBeNull()
    expect(screen.queryByTestId('seg-include')).toBeNull()
  })
})

describe('RunList bulk actions (Lane B, B5 — floating selection popup, Round 2)', () => {
  it('selecting a non-archived row shows the selection popup with an Archive action', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())

    fireEvent.click(screen.getByTestId(`run-select-${ACTIVE.id}`))
    expect(screen.getByTestId('run-bulk-bar')).toBeTruthy()
    expect(screen.getByTestId('run-bulk-archive').textContent).toContain('Archive')
    // Archive-all only makes sense on the Active segment.
    expect(screen.getByTestId('run-bulk-archive-all')).toBeTruthy()

    fireEvent.click(screen.getByTestId('run-bulk-archive'))
    await waitFor(() => expect(archiveCalls).toContain(ACTIVE.id))
    // selection clears + list re-fetches after a bulk action
    await waitFor(() => expect(screen.queryByTestId('run-bulk-bar')).toBeNull())
  })

  it('selecting only archived rows flips the popup to Unarchive and hides Archive-all', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    fireEvent.click(screen.getByTestId('seg-only'))
    await waitFor(() => expect(screen.getByText('archived run')).toBeTruthy())

    fireEvent.click(screen.getByTestId(`run-select-${ARCHIVED.id}`))
    expect(screen.getByTestId('run-bulk-archive').textContent).toContain('Unarchive')
    expect(screen.queryByTestId('run-bulk-archive-all')).toBeNull()

    fireEvent.click(screen.getByTestId('run-bulk-archive'))
    await waitFor(() => expect(unarchiveCalls).toContain(ARCHIVED.id))
  })

  it('"Archive all" archives every currently-listed active run, independent of checkbox selection', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())

    // Select the row just to make the popup appear — Archive-all ignores the selection set.
    fireEvent.click(screen.getByTestId(`run-select-${ACTIVE.id}`))
    fireEvent.click(screen.getByTestId('run-bulk-archive-all'))

    await waitFor(() => expect(archiveCalls).toContain(ACTIVE.id))
  })

  it('Delete permanently opens a confirm dialog; confirming calls DELETE', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    fireEvent.click(screen.getByTestId('seg-only'))
    await waitFor(() => expect(screen.getByText('archived run')).toBeTruthy())

    fireEvent.click(screen.getByTestId(`run-select-${ARCHIVED.id}`))
    fireEvent.click(screen.getByTestId('run-bulk-delete'))

    // Radix portals the dialog to document.body; screen queries there regardless.
    const confirmBtn = await screen.findByTestId('run-bulk-delete-dialog-confirm')
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(deleteCalls).toContain(ARCHIVED.id))
  })

  it('the row checkbox does not trigger row selection (stops propagation)', async () => {
    const { onSelect } = renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    fireEvent.click(screen.getByTestId(`run-select-${ACTIVE.id}`))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('"Clear finished" calls the bulk clear-finished endpoint', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active run')).toBeTruthy())
    fireEvent.click(screen.getByTestId('run-clear-finished'))
    await waitFor(() => expect(clearFinishedCalls).toBe(1))
  })
})
