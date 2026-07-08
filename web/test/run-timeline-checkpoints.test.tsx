/**
 * RunTimeline checkpoint markers (P1 C2) — checkpoint events render an
 * accent-tinted marker row whose wave/sha chip comes from the checkpoints
 * endpoint (full sha — NOT parsed from event text). The "Rewind here" button
 * is gated on the terminal prop and opens the RewindDialog seeded with that
 * checkpoint.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentEvent, RunCheckpoint } from '@k/shared'

beforeAll(() => {
  // jsdom implements neither scrollIntoView (timeline autoscroll) nor
  // matchMedia (framer-motion inside the dialog's Toast).
  Element.prototype.scrollIntoView = vi.fn()
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockCheckpoints, mockRewind } = vi.hoisted(() => ({
  mockCheckpoints: vi.fn(),
  mockRewind: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: { runs: { eventRaw: vi.fn().mockResolvedValue(null), checkpoints: mockCheckpoints, rewind: mockRewind } },
}))
vi.mock('../src/lib/route', () => ({ navigate: vi.fn() }))

import RunTimeline from '../src/components/RunTimeline'

const SHA = 'c0ffee1234'.repeat(4) // full 40-char sha
const CKPT: RunCheckpoint = { sha: SHA, tree: 'd'.repeat(40), ref: 'refs/k-checkpoints/r1', wave: 1, seq: 1, ts: 2000 }

function ev(seq: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `e${seq}`, runId: 'r1', seq, type: 'assistant', ts: 1000 + seq * 1000, text: `#${seq}`, ...over }
}

const EVENTS = [
  ev(0),
  ev(1, { type: 'checkpoint', text: `checkpoint wave 1 (${SHA.slice(0, 10)})` }),
  ev(2),
]

function renderTimeline(terminal = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RunTimeline events={EVENTS} runId="r1" terminal={terminal} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckpoints.mockResolvedValue([CKPT])
  mockRewind.mockResolvedValue({ id: 'r2' })
})
afterEach(() => cleanup())

describe('RunTimeline — checkpoint markers', () => {
  it('renders a marker row with the wave · sha10 chip from the chain', async () => {
    renderTimeline()
    const marker = await screen.findByTestId('ckpt-marker-1')
    expect(marker.textContent).toContain(`wave 1 · ${SHA.slice(0, 10)}`)
    expect(mockCheckpoints).toHaveBeenCalledWith('r1')
  })

  it('clicking "Rewind here" opens the RewindDialog seeded with that checkpoint', async () => {
    renderTimeline()
    fireEvent.click(await screen.findByText('Rewind here'))
    const dialog = screen.getByTestId('rewind-dialog')
    expect(dialog.textContent).toContain(`wave 1 · ${SHA.slice(0, 10)}`)
  })

  it('hides the rewind affordance for non-terminal runs (marker still renders)', async () => {
    renderTimeline(false)
    await screen.findByTestId('ckpt-marker-1')
    expect(screen.queryByText('Rewind here')).toBeNull()
  })
})
