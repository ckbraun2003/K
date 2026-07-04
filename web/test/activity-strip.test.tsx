/**
 * ActivityStrip (F-004): day totals (runs / cost / tokens) were duplicated on the
 * strip on every page. Per the documented design (D-026 / CLAIM-08-5) they live
 * ONLY on the Metrics "Today" tiles, so the strip must no longer render them — it
 * stays focused on live/last run activity.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Run } from '@k/shared'

const { runsRef } = vi.hoisted(() => ({ runsRef: { current: [] as Run[] } }))

vi.mock('../src/lib/runs-query', () => ({
  RUNS_LIST_KEY: ['runs', 'list', 'default'],
  runsListQueryFn: async () => runsRef.current,
}))
vi.mock('../src/lib/ws', () => ({ onWsMessage: () => () => {} }))
vi.mock('../src/lib/live-invalidate', () => ({
  makeRunUpdateInvalidator: () => ({ handler: () => {}, dispose: () => {} }),
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import ActivityStrip from '../src/shell/ActivityStrip'

beforeEach(() => { runsRef.current = [] })
afterEach(() => cleanup())

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ActivityStrip />
    </QueryClientProvider>,
  )
}

describe('ActivityStrip', () => {
  it('does not render day totals (runs today / cost / tokens)', () => {
    const { container } = renderStrip()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/runs today/i)
    expect(text).not.toMatch(/tok\b/)
    expect(text).not.toContain('$')
    // still shows the idle activity message
    expect(screen.getByText(/idle — no agents running/i)).toBeTruthy()
  })
})
