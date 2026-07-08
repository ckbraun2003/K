/**
 * RewindDialog (P1 C2) — compose-is-confirm dialog for rewind-and-redispatch
 * from a checkpoint. Locks: the checkpoint chip (wave + sha10), Dispatch
 * disabled on an empty prompt, the api.runs.rewind payload, the success toast
 * with a View-run action navigating to the NEW run, error surfacing, and
 * Escape/backdrop both closing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error minimal stub for framer-motion (Toast)
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  }
})

const { mockRewind, mockNavigate } = vi.hoisted(() => ({
  mockRewind: vi.fn(),
  mockNavigate: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({ api: { runs: { rewind: mockRewind } } }))
vi.mock('../src/lib/route', () => ({ navigate: mockNavigate }))

import RewindDialog from '../src/components/RewindDialog'

const SHA = 'a'.repeat(40)

function renderDialog(over: { checkpoint?: { sha: string; wave: number } | null; onClose?: () => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = over.onClose ?? vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <RewindDialog
        runId="r1"
        checkpoint={over.checkpoint === undefined ? { sha: SHA, wave: 2 } : over.checkpoint}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return onClose
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRewind.mockResolvedValue({ id: 'r2' })
})
afterEach(() => cleanup())

describe('RewindDialog', () => {
  it('renders nothing when checkpoint is null', () => {
    renderDialog({ checkpoint: null })
    expect(screen.queryByTestId('rewind-dialog')).toBeNull()
  })

  it('shows the checkpoint chip (wave + sha10)', () => {
    renderDialog()
    expect(screen.getByTestId('rewind-dialog').textContent).toContain(`wave 2 · ${SHA.slice(0, 10)}`)
  })

  it('disables Dispatch while the prompt is empty (whitespace counts as empty)', () => {
    renderDialog()
    expect((screen.getByTestId('rewind-dispatch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('rewind-prompt'), { target: { value: '   ' } })
    expect((screen.getByTestId('rewind-dispatch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('rewind-prompt'), { target: { value: 'go' } })
    expect((screen.getByTestId('rewind-dispatch') as HTMLButtonElement).disabled).toBe(false)
  })

  it('dispatches via api.runs.rewind and shows the toast with a View-run action', async () => {
    const onClose = renderDialog()
    fireEvent.change(screen.getByTestId('rewind-prompt'), { target: { value: 'continue from here' } })
    fireEvent.click(screen.getByTestId('rewind-dispatch'))
    await waitFor(() =>
      expect(mockRewind).toHaveBeenCalledWith('r1', { sha: SHA, prompt: 'continue from here' }),
    )
    const toast = await screen.findByTestId('rewind-toast')
    expect(toast.textContent).toContain('Rewound run dispatched')
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByText('View run'))
    expect(mockNavigate).toHaveBeenCalledWith('runs', 'r2')
  })

  it('surfaces a rewind error inside the dialog', async () => {
    mockRewind.mockRejectedValue(new Error('dirty worktree'))
    renderDialog()
    fireEvent.change(screen.getByTestId('rewind-prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('rewind-dispatch'))
    expect(await screen.findByText('dirty worktree')).toBeTruthy()
  })

  it('Escape closes', () => {
    const onClose = renderDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('backdrop click closes; clicks inside the panel do not', () => {
    const onClose = renderDialog()
    fireEvent.click(screen.getByTestId('rewind-prompt'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('rewind-dialog'))
    expect(onClose).toHaveBeenCalled()
  })

  it('reopening for another checkpoint clears the stale draft and error (persistent instance)', async () => {
    // The dialog is ONE persistent instance in RunTimeline — only the checkpoint
    // prop toggles. A failed dispatch for checkpoint A must not leak its draft
    // prompt or error message into a later open for checkpoint B.
    mockRewind.mockRejectedValueOnce(new Error('dirty worktree'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    const view = (checkpoint: { sha: string; wave: number } | null) => (
      <QueryClientProvider client={qc}>
        <RewindDialog runId="r1" checkpoint={checkpoint} onClose={onClose} />
      </QueryClientProvider>
    )
    const { rerender } = render(view({ sha: SHA, wave: 2 }))
    fireEvent.change(screen.getByTestId('rewind-prompt'), { target: { value: 'stale draft' } })
    fireEvent.click(screen.getByTestId('rewind-dispatch'))
    await screen.findByText('dirty worktree')
    rerender(view(null)) // close
    rerender(view({ sha: 'b'.repeat(40), wave: 3 })) // reopen for a different checkpoint
    await waitFor(() =>
      expect((screen.getByTestId('rewind-prompt') as HTMLTextAreaElement).value).toBe(''),
    )
    expect(screen.queryByText('dirty worktree')).toBeNull()
    expect(screen.getByTestId('rewind-dialog').textContent).toContain(`wave 3 · ${'b'.repeat(10)}`)
  })
})
