/**
 * Settings → Appearance background picker (usability-access B.5). Mirrors the
 * ClaudeModelSection test harness (local-models.test.tsx) — mocked `api`, a
 * REAL QueryClient (not faked) so a successful save's `invalidateQueries`
 * genuinely triggers a refetch, proving the mutation invalidates `['background']`
 * rather than just calling `set`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BackgroundVariant } from '@k/shared'

const OPTIONS: BackgroundVariant[] = ['galaxy', 'aurora', 'blobs', 'solid']

let currentVariant: BackgroundVariant = 'galaxy'
const getSpy = vi.fn(async () => ({ variant: currentVariant, options: OPTIONS }))
const setSpy = vi.fn(async (variant: BackgroundVariant) => {
  currentVariant = variant
  return { variant }
})

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: () => getSpy(),
        set: (variant: BackgroundVariant) => setSpy(variant),
      },
    },
  },
}))

import { BackgroundSection } from '../src/pages/SettingsAppearance'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  currentVariant = 'galaxy'
  getSpy.mockClear()
  setSpy.mockClear()
})
afterEach(() => cleanup())

describe('BackgroundSection', () => {
  it('renders a Select seeded with the current variant + all four options', async () => {
    renderWithQuery(<BackgroundSection />)
    const select = await screen.findByTestId('background-select') as HTMLSelectElement
    expect(select.value).toBe('galaxy')
    expect(screen.getByRole('option', { name: 'Galaxy' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Aurora' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Blobs' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Solid' })).toBeTruthy()
  })

  it('changing the selection saves the new variant and invalidates the query (refetch reflects it)', async () => {
    renderWithQuery(<BackgroundSection />)
    const select = await screen.findByTestId('background-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'aurora' } })

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith('aurora'))
    await waitFor(() => {
      expect((screen.getByTestId('background-select') as HTMLSelectElement).value).toBe('aurora')
    })
    // proves invalidateQueries(['background']) fired a real refetch, not just a local echo
    expect(getSpy.mock.calls.length).toBeGreaterThan(1)
  })
})
