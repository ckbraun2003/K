/**
 * Settings → Appearance wallpaper picker (usability-access P2.6 wallpaper
 * UI). Mocked `api`, a REAL QueryClient (not faked) so a successful
 * set()/uploadImage() genuinely triggers `['background']` invalidation →
 * refetch, proving the mutation invalidates rather than just calling the
 * mock (mirrors the ClaudeModelSection test harness convention).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BackgroundKind, GradientPreset, BackgroundSettings } from '@k/shared'

const PRESETS: GradientPreset[] = ['aurora', 'dusk', 'ocean', 'ember']
const KINDS: BackgroundKind[] = ['solid', 'gradient', 'image']

let current: BackgroundSettings = { kind: 'solid', preset: null, imageVersion: null }

const getSpy = vi.fn(async () => ({ settings: current, presets: PRESETS, kinds: KINDS }))
const setSpy = vi.fn(async (patch: { kind: BackgroundKind; preset: GradientPreset | null }) => {
  current = { ...current, ...patch }
  return { settings: current }
})
const uploadImageSpy = vi.fn(async (_dataUrl: string) => {
  current = { kind: 'image', preset: null, imageVersion: (current.imageVersion ?? 0) + 1 }
  return { settings: current }
})
const imageBlobSpy = vi.fn(async (_version: number) => new Blob(['fake-bytes'], { type: 'image/png' }))

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: () => getSpy(),
        set: (patch: { kind: BackgroundKind; preset: GradientPreset | null }) => setSpy(patch),
        uploadImage: (dataUrl: string) => uploadImageSpy(dataUrl),
        imageBlob: (version: number) => imageBlobSpy(version),
      },
    },
  },
}))

import { BackgroundSection } from '../src/pages/SettingsAppearance'

// Deterministic FileReader stand-in — jsdom's real implementation is fine in
// modern versions, but mocking keeps the data-URL content and timing fixed.
class MockFileReader {
  result: string | ArrayBuffer | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(_file: Blob) {
    this.result = 'data:image/png;base64,ZmFrZS1ieXRlcw=='
    queueMicrotask(() => this.onload?.())
  }
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  current = { kind: 'solid', preset: null, imageVersion: null }
  getSpy.mockClear()
  setSpy.mockClear()
  uploadImageSpy.mockClear()
  imageBlobSpy.mockClear()
  URL.createObjectURL = vi.fn(() => 'blob:mock-object-url')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('FileReader', MockFileReader)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.createObjectURL
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.revokeObjectURL
})

describe('BackgroundSection (wallpaper picker)', () => {
  it('renders the kind select seeded with the current kind + all three options', async () => {
    renderWithQuery(<BackgroundSection />)
    const select = await screen.findByTestId('background-kind-select') as HTMLSelectElement
    expect(select.value).toBe('solid')
    expect(screen.getByRole('option', { name: 'Solid' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Gradient' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Image' })).toBeTruthy()
  })

  it('switching kind to gradient calls set() and invalidates ["background"] (refetch reflects it)', async () => {
    renderWithQuery(<BackgroundSection />)
    const select = await screen.findByTestId('background-kind-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'gradient' } })

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith({ kind: 'gradient', preset: 'aurora' }))
    await waitFor(() => {
      expect((screen.getByTestId('background-kind-select') as HTMLSelectElement).value).toBe('gradient')
    })
    // proves invalidateQueries(['background']) fired a real refetch, not just a local echo
    expect(getSpy.mock.calls.length).toBeGreaterThan(1)
    // a preset select appears once kind is gradient
    expect(screen.getByTestId('background-preset-select')).toBeTruthy()
  })

  it('changing the gradient preset calls set() with the new preset', async () => {
    current = { kind: 'gradient', preset: 'aurora', imageVersion: null }
    renderWithQuery(<BackgroundSection />)
    const presetSelect = await screen.findByTestId('background-preset-select') as HTMLSelectElement
    fireEvent.change(presetSelect, { target: { value: 'dusk' } })

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith({ kind: 'gradient', preset: 'dusk' }))
  })

  it('selecting a file in the image input reads it as a data URL and calls uploadImage()', async () => {
    renderWithQuery(<BackgroundSection />)
    const fileInput = await screen.findByTestId('background-image-input') as HTMLInputElement
    const file = new File(['fake-bytes'], 'wallpaper.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(uploadImageSpy).toHaveBeenCalledWith('data:image/png;base64,ZmFrZS1ieXRlcw==')
    })
    // proves invalidateQueries(['background']) fired a real refetch after upload
    await waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThan(1))
  })

  it('the image kind option is disabled until an image has been uploaded', async () => {
    renderWithQuery(<BackgroundSection />)
    await screen.findByTestId('background-kind-select')
    const imageOption = screen.getByRole('option', { name: 'Image' }) as HTMLOptionElement
    expect(imageOption.disabled).toBe(true)
  })

  it('once an image exists, the image kind option is selectable', async () => {
    current = { kind: 'solid', preset: null, imageVersion: 2 }
    renderWithQuery(<BackgroundSection />)
    await screen.findByTestId('background-kind-select')
    const imageOption = screen.getByRole('option', { name: 'Image' }) as HTMLOptionElement
    expect(imageOption.disabled).toBe(false)
  })
})
