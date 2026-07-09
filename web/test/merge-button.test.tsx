/**
 * P2 C3 — MergeButton: renders only for an OPEN PR; enabled only when checks are
 * green; click → confirm dialog → api.projects.mergePr(projectId, number) → toast.
 * Disabled (non-green) button carries the `checks are <checks> — merge blocked` title.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PrInfo } from '@k/shared'

const { mockMergePr } = vi.hoisted(() => ({ mockMergePr: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  api: { projects: { mergePr: mockMergePr } },
}))

import MergeButton from '../src/components/MergeButton'

// jsdom has no matchMedia; framer-motion (ConfirmDialog/Toast) probes it. Inert stub.
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error – minimal stub is enough for framer-motion
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })
  }
})

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return { number: 7, title: 'my change', state: 'OPEN', url: 'https://github.com/o/r/pull/7', checks: 'passing', ...over }
}

function renderButton(p: PrInfo) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MergeButton projectId="p1" pr={p} />
    </QueryClientProvider>,
  )
}

beforeEach(() => { mockMergePr.mockReset() })
afterEach(() => cleanup())

describe('MergeButton', () => {
  it('a green OPEN PR merges via confirm → api.projects.mergePr(projectId, number) → success toast', async () => {
    mockMergePr.mockResolvedValue({ merged: true, number: 7 })
    const user = userEvent.setup()
    renderButton(pr())

    const btn = screen.getByTestId('pr-merge-7') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    await user.click(btn)
    await screen.findByTestId('pr-merge-dialog')
    await user.click(screen.getByTestId('pr-merge-dialog-confirm'))

    await waitFor(() => expect(mockMergePr).toHaveBeenCalledWith('p1', 7))
    expect(await screen.findByText('PR #7 merged')).toBeTruthy()
  })

  it('disables the button with a blocked title when checks are not green', () => {
    renderButton(pr({ checks: 'pending' }))
    const btn = screen.getByTestId('pr-merge-7') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('checks are pending — merge blocked')
    expect(mockMergePr).not.toHaveBeenCalled()
  })

  it('renders nothing for a non-OPEN (merged) PR', () => {
    const { container } = renderButton(pr({ state: 'MERGED', checks: 'none' }))
    expect(screen.queryByTestId('pr-merge-7')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })
})
