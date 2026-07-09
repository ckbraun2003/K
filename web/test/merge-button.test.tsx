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

  it('a click inside the confirm dialog does not bubble to the parent PR row (MED-1)', async () => {
    // The dialog is a fixed overlay but a CHILD (React tree) of PrsCiTab's clickable
    // role="button" PR row; a Cancel/backdrop/Merge click must NOT bubble up to the
    // row's onClick (which would toggle expand → a stray `gh pr diff` fetch).
    mockMergePr.mockResolvedValue({ merged: true, number: 7 })
    const parentSpy = vi.fn()
    const user = userEvent.setup()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <div onClick={parentSpy}>
          <MergeButton projectId="p1" pr={pr()} />
        </div>
      </QueryClientProvider>,
    )
    // open the confirm dialog, then click its Cancel control
    await user.click(screen.getByTestId('pr-merge-7'))
    await screen.findByTestId('pr-merge-dialog')
    await user.click(screen.getByTestId('pr-merge-dialog-cancel'))
    // neither the merge-button click nor the dialog Cancel click reached the parent row
    expect(parentSpy).not.toHaveBeenCalled()
  })

  it('a click on the success Toast dismiss does not bubble to the parent PR row (MAJOR-1)', async () => {
    // After a merge the Toast (a fixed overlay, still a React-tree CHILD of the PR
    // row) shows a ✕ dismiss; its click must also be stopped at the tree boundary,
    // else it reaches PrRow.onClick and toggles expand (a stray `gh pr diff` fetch).
    mockMergePr.mockResolvedValue({ merged: true, number: 7 })
    const parentSpy = vi.fn()
    const user = userEvent.setup()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <div onClick={parentSpy}>
          <MergeButton projectId="p1" pr={pr()} />
        </div>
      </QueryClientProvider>,
    )
    await user.click(screen.getByTestId('pr-merge-7'))
    await user.click(await screen.findByTestId('pr-merge-dialog-confirm'))
    await screen.findByText('PR #7 merged')
    await user.click(screen.getByLabelText('Dismiss'))
    expect(parentSpy).not.toHaveBeenCalled()
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
