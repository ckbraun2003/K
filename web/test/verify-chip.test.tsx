/**
 * VerifyChip (E-04, P1 Task 9/B2) — the run-level verify badge. Locks: an
 * absent result (the 404 → null query) renders NOTHING; a pass result renders
 * the `Verified` chip (data-testid="verify-chip"); clicking toggles the
 * anchored popover with per-command rows (label · exitCode · duration) and
 * scope chips (`N files changed`, `M indexed symbols`); a fail result renders
 * `Verify failed`. Chip cache key FROZEN as ['run-verify', runId].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VerifyResult } from '@k/shared'

const { mockVerifyResult } = vi.hoisted(() => ({ mockVerifyResult: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: { runs: { verifyResult: mockVerifyResult } },
}))

import VerifyChip from '../src/components/VerifyChip'

const passResult: VerifyResult = {
  runId: 'run-1',
  status: 'pass',
  reason: null,
  commands: [
    { label: 'typecheck', run: 'pnpm typecheck', exitCode: 0, ok: true, durationMs: 3200, outputTail: '' },
    { label: 'unit', run: 'pnpm vitest run', exitCode: 0, ok: true, durationMs: 12400, outputTail: '' },
  ],
  scope: { files: ['a.ts', 'b.ts', 'c.ts'], symbols: 12, indexed: true },
  startedAt: 1,
  completedAt: 2,
}

const failResult: VerifyResult = {
  ...passResult,
  status: 'fail',
  commands: [
    passResult.commands[0],
    { label: 'unit', run: 'pnpm vitest run', exitCode: 1, ok: false, durationMs: 9000, outputTail: 'FAIL' },
  ],
}

function renderChip(runId = 'run-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <VerifyChip runId={runId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

describe('VerifyChip', () => {
  it('renders NOTHING when no result exists (BE-3: absent → 200 {result:null}, not a thrown 404)', async () => {
    mockVerifyResult.mockResolvedValue(null)
    renderChip()
    await waitFor(() => expect(mockVerifyResult).toHaveBeenCalledWith('run-1'))
    expect(screen.queryByTestId('verify-chip')).toBeNull()
  })

  it('renders the Verified chip for a pass result', async () => {
    mockVerifyResult.mockResolvedValue(passResult)
    renderChip()
    const chip = await screen.findByTestId('verify-chip')
    expect(chip.textContent).toBe('Verified')
    // popover is closed until clicked
    expect(screen.queryByTestId('verify-popover')).toBeNull()
  })

  it('click opens the popover with per-command rows + scope chips', async () => {
    mockVerifyResult.mockResolvedValue(passResult)
    renderChip()
    fireEvent.click(await screen.findByTestId('verify-chip'))
    const popover = screen.getByTestId('verify-popover')
    // per-command rows: label · exitCode · duration
    expect(popover.textContent).toContain('typecheck')
    expect(popover.textContent).toContain('unit')
    expect(popover.textContent).toContain('exit 0')
    expect(popover.textContent).toContain('3.2s')
    expect(popover.textContent).toContain('12.4s')
    // scope chips
    expect(popover.textContent).toContain('3 files changed')
    expect(popover.textContent).toContain('12 indexed symbols')
    // second click toggles it closed
    fireEvent.click(screen.getByTestId('verify-chip'))
    expect(screen.queryByTestId('verify-popover')).toBeNull()
  })

  it('renders Verify failed for a fail result', async () => {
    mockVerifyResult.mockResolvedValue(failResult)
    renderChip()
    const chip = await screen.findByTestId('verify-chip')
    expect(chip.textContent).toBe('Verify failed')
  })

  it('does not repeat the fetch on remount after a settled null result (LOW-1: stop polling past the first miss)', async () => {
    // BE-3 contract (Task 11): absence resolves to null, it never rejects — a
    // rejected/errored query has dataUpdatedAt=0, which react-query treats as
    // permanently stale regardless of staleTime, defeating the exact
    // no-repeat-fetch guarantee this test exists to lock in.
    mockVerifyResult.mockResolvedValue(null)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <VerifyChip runId="run-1" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(mockVerifyResult).toHaveBeenCalledTimes(1))
    unmount()
    render(
      <QueryClientProvider client={qc}>
        <VerifyChip runId="run-1" />
      </QueryClientProvider>,
    )
    // Give a remount every chance to refetch, then assert it never did.
    await waitFor(() => expect(screen.queryByTestId('verify-chip')).toBeNull())
    expect(mockVerifyResult).toHaveBeenCalledTimes(1)
  })

  it('aria-expanded reflects popover state and Escape closes it (P1 SEAMS L2)', async () => {
    mockVerifyResult.mockResolvedValue(passResult)
    renderChip()
    const chip = await screen.findByTestId('verify-chip')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chip)
    expect(screen.getByTestId('verify-popover')).toBeTruthy()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('verify-popover')).toBeNull())
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })
})
