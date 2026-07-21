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

let currentFontColor: { color: string | null } = { color: null }
const fontColorGetSpy = vi.fn(async () => ({ settings: currentFontColor }))
const fontColorSetSpy = vi.fn(async (patch: { color: string | null }) => {
  currentFontColor = { ...patch }
  return { settings: currentFontColor }
})

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: () => getSpy(),
        set: (patch: { kind: BackgroundKind; preset: GradientPreset | null }) => setSpy(patch),
        uploadImage: (dataUrl: string) => uploadImageSpy(dataUrl),
        imageBlob: (version: number) => imageBlobSpy(version),
      },
      fontColor: {
        get: () => fontColorGetSpy(),
        set: (patch: { color: string | null }) => fontColorSetSpy(patch),
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

// Deterministic Image stand-in for the too-small-dimensions probe — defaults
// to a size larger than the stubbed viewport below so existing upload tests
// (which don't care about the warning) never trigger it.
let mockImageNaturalSize = { width: 4000, height: 3000 }
class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  set src(_v: string) {
    this.naturalWidth = mockImageNaturalSize.width
    this.naturalHeight = mockImageNaturalSize.height
    queueMicrotask(() => this.onload?.())
  }
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  current = { kind: 'solid', preset: null, imageVersion: null }
  currentFontColor = { color: null }
  mockImageNaturalSize = { width: 4000, height: 3000 }
  getSpy.mockClear()
  setSpy.mockClear()
  uploadImageSpy.mockClear()
  imageBlobSpy.mockClear()
  fontColorGetSpy.mockClear()
  fontColorSetSpy.mockClear()
  URL.createObjectURL = vi.fn(() => 'blob:mock-object-url')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('FileReader', MockFileReader)
  vi.stubGlobal('Image', MockImage)
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('devicePixelRatio', 1)
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

  it('uploading an image smaller than the (dpr-scaled) screen shows a non-blocking warning', async () => {
    mockImageNaturalSize = { width: 400, height: 300 } // viewport stubbed to 1000x800 above
    renderWithQuery(<BackgroundSection />)
    const fileInput = await screen.findByTestId('background-image-input') as HTMLInputElement
    const file = new File(['fake-bytes'], 'wallpaper.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    // Upload proceeds regardless of the probe outcome — never blocked.
    await waitFor(() => expect(uploadImageSpy).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByTestId('background-size-warning').textContent).toContain('400×300')
    })
    expect(screen.getByTestId('background-size-warning').textContent).toContain('1000×800')
  })

  it('uploading an image at least as large as the screen shows no warning', async () => {
    mockImageNaturalSize = { width: 4000, height: 3000 }
    renderWithQuery(<BackgroundSection />)
    const fileInput = await screen.findByTestId('background-image-input') as HTMLInputElement
    const file = new File(['fake-bytes'], 'wallpaper.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(uploadImageSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('background-size-warning')).toBeNull()
  })
})

describe('FontColorPicker (text-colour override)', () => {
  it('shows the theme-default swatch and a disabled Reset button when no override is set', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('font-color-input') as HTMLInputElement
    await waitFor(() => expect(fontColorGetSpy).toHaveBeenCalled())
    expect(input.value).toMatch(/^#[0-9a-f]{6}$/)
    expect((screen.getByText('Reset to default').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('changing the color input calls fontColor.set() and invalidates the query (refetch reflects it)', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('font-color-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#ff00aa' } })

    await waitFor(() => expect(fontColorSetSpy).toHaveBeenCalledWith({ color: '#ff00aa' }))
    await waitFor(() => expect((screen.getByTestId('font-color-input') as HTMLInputElement).value).toBe('#ff00aa'))
    expect((screen.getByText('Reset to default').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('"Reset to default" calls fontColor.set({ color: null })', async () => {
    currentFontColor = { color: '#123456' }
    renderWithQuery(<BackgroundSection />)
    const resetButton = await screen.findByText('Reset to default')
    await waitFor(() => expect((screen.getByTestId('font-color-input') as HTMLInputElement).value).toBe('#123456'))
    fireEvent.click(resetButton)

    await waitFor(() => expect(fontColorSetSpy).toHaveBeenCalledWith({ color: null }))
  })
})
