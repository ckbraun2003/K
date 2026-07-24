/**
 * Settings → Appearance wallpaper picker (usability-access P2.6 wallpaper
 * UI; extended ui-adjustments Round 4 with a solid-color override + primary/
 * secondary accent pickers, gradient dropped from the UI). Mocked `api`, a
 * REAL QueryClient (not faked) so a successful set()/uploadImage() genuinely
 * triggers `['background']` invalidation → refetch, proving the mutation
 * invalidates rather than just calling the mock (mirrors the
 * ClaudeModelSection test harness convention).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BackgroundKind, GradientPreset, BackgroundSettings } from '@k/shared'

const PRESETS: GradientPreset[] = ['aurora', 'dusk', 'ocean', 'ember']
const KINDS: BackgroundKind[] = ['solid', 'gradient', 'image']

let current: BackgroundSettings = { kind: 'solid', preset: null, imageVersion: null, solidColor: null }

const getSpy = vi.fn(async () => ({ settings: current, presets: PRESETS, kinds: KINDS }))
const setSpy = vi.fn(async (patch: { kind: BackgroundKind; preset: GradientPreset | null; solidColor: string | null }) => {
  current = { ...current, ...patch }
  return { settings: current }
})
const uploadImageSpy = vi.fn(async (_dataUrl: string) => {
  current = { kind: 'image', preset: null, imageVersion: (current.imageVersion ?? 0) + 1, solidColor: current.solidColor }
  return { settings: current }
})
const imageBlobSpy = vi.fn(async (_version: number) => new Blob(['fake-bytes'], { type: 'image/png' }))

let currentFontColor: { color: string | null } = { color: null }
const fontColorGetSpy = vi.fn(async () => ({ settings: currentFontColor }))
const fontColorSetSpy = vi.fn(async (patch: { color: string | null }) => {
  currentFontColor = { ...patch }
  return { settings: currentFontColor }
})

let currentPrimaryColor: { color: string | null } = { color: null }
const primaryColorGetSpy = vi.fn(async () => ({ settings: currentPrimaryColor }))
const primaryColorSetSpy = vi.fn(async (patch: { color: string | null }) => {
  currentPrimaryColor = { ...patch }
  return { settings: currentPrimaryColor }
})

let currentSecondaryColor: { color: string | null } = { color: null }
const secondaryColorGetSpy = vi.fn(async () => ({ settings: currentSecondaryColor }))
const secondaryColorSetSpy = vi.fn(async (patch: { color: string | null }) => {
  currentSecondaryColor = { ...patch }
  return { settings: currentSecondaryColor }
})

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: () => getSpy(),
        set: (patch: { kind: BackgroundKind; preset: GradientPreset | null; solidColor: string | null }) => setSpy(patch),
        uploadImage: (dataUrl: string) => uploadImageSpy(dataUrl),
        imageBlob: (version: number) => imageBlobSpy(version),
      },
      fontColor: {
        get: () => fontColorGetSpy(),
        set: (patch: { color: string | null }) => fontColorSetSpy(patch),
      },
      primaryColor: {
        get: () => primaryColorGetSpy(),
        set: (patch: { color: string | null }) => primaryColorSetSpy(patch),
      },
      secondaryColor: {
        get: () => secondaryColorGetSpy(),
        set: (patch: { color: string | null }) => secondaryColorSetSpy(patch),
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
  current = { kind: 'solid', preset: null, imageVersion: null, solidColor: null }
  currentFontColor = { color: null }
  currentPrimaryColor = { color: null }
  currentSecondaryColor = { color: null }
  mockImageNaturalSize = { width: 4000, height: 3000 }
  getSpy.mockClear()
  setSpy.mockClear()
  uploadImageSpy.mockClear()
  imageBlobSpy.mockClear()
  fontColorGetSpy.mockClear()
  fontColorSetSpy.mockClear()
  primaryColorGetSpy.mockClear()
  primaryColorSetSpy.mockClear()
  secondaryColorGetSpy.mockClear()
  secondaryColorSetSpy.mockClear()
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
  it('renders a Solid | Image segmented toggle — no gradient option, no <select>', async () => {
    renderWithQuery(<BackgroundSection />)
    await screen.findByTestId('seg-solid')
    expect(screen.getByTestId('seg-image')).toBeTruthy()
    expect(screen.queryByTestId('seg-gradient')).toBeNull()
    expect(screen.queryByTestId('background-kind-select')).toBeNull()
    expect(screen.queryByTestId('background-preset-select')).toBeNull()
  })

  it('seeds the toggle from the current kind — solid pressed when kind is solid', async () => {
    renderWithQuery(<BackgroundSection />)
    const solidSeg = await screen.findByTestId('seg-solid') as HTMLButtonElement
    expect(solidSeg.getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('seg-image') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })

  it('a persisted legacy gradient kind coerces the toggle to the Solid segment', async () => {
    current = { kind: 'gradient', preset: 'aurora', imageVersion: null, solidColor: null }
    renderWithQuery(<BackgroundSection />)
    const solidSeg = await screen.findByTestId('seg-solid') as HTMLButtonElement
    await waitFor(() => expect(solidSeg.getAttribute('aria-pressed')).toBe('true'))
  })

  it('the Image segment is disabled until an image has been uploaded', async () => {
    renderWithQuery(<BackgroundSection />)
    const imageSeg = await screen.findByTestId('seg-image') as HTMLButtonElement
    expect(imageSeg.disabled).toBe(true)
  })

  it('once an image exists, the Image segment is selectable', async () => {
    current = { kind: 'solid', preset: null, imageVersion: 2, solidColor: null }
    renderWithQuery(<BackgroundSection />)
    const imageSeg = await screen.findByTestId('seg-image') as HTMLButtonElement
    expect(imageSeg.disabled).toBe(false)
  })

  it('choosing Image calls set() with kind:"image", preserving the current solidColor', async () => {
    current = { kind: 'solid', preset: null, imageVersion: 2, solidColor: '#334455' }
    renderWithQuery(<BackgroundSection />)
    const imageSeg = await screen.findByTestId('seg-image') as HTMLButtonElement
    fireEvent.click(imageSeg)

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith({ kind: 'image', preset: null, solidColor: '#334455' }))
    // proves invalidateQueries(['background']) fired a real refetch, not just a local echo
    await waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThan(1))
  })

  it('choosing Solid shows the solid-color input and it PUTs solidColor on change', async () => {
    current = { kind: 'solid', preset: null, imageVersion: null, solidColor: null }
    renderWithQuery(<BackgroundSection />)
    const colorInput = await screen.findByTestId('background-solid-color') as HTMLInputElement
    fireEvent.change(colorInput, { target: { value: '#aabbcc' } })

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith({ kind: 'solid', preset: null, solidColor: '#aabbcc' }))
    await waitFor(() => {
      expect((screen.getByTestId('background-solid-color') as HTMLInputElement).value).toBe('#aabbcc')
    })
  })

  it('the solid-color input is hidden while the Image segment is active', async () => {
    current = { kind: 'image', preset: null, imageVersion: 1, solidColor: null }
    renderWithQuery(<BackgroundSection />)
    await screen.findByTestId('seg-image')
    expect(screen.queryByTestId('background-solid-color')).toBeNull()
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
    // Three "Reset to default" buttons now render (font/primary/secondary) —
    // this is the first, [0].
    expect((screen.getAllByText('Reset to default')[0].closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('changing the color input calls fontColor.set() and invalidates the query (refetch reflects it)', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('font-color-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#ff00aa' } })

    await waitFor(() => expect(fontColorSetSpy).toHaveBeenCalledWith({ color: '#ff00aa' }))
    await waitFor(() => expect((screen.getByTestId('font-color-input') as HTMLInputElement).value).toBe('#ff00aa'))
    expect((screen.getAllByText('Reset to default')[0].closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('"Reset to default" calls fontColor.set({ color: null })', async () => {
    currentFontColor = { color: '#123456' }
    renderWithQuery(<BackgroundSection />)
    await screen.findByTestId('font-color-input')
    await waitFor(() => expect((screen.getByTestId('font-color-input') as HTMLInputElement).value).toBe('#123456'))
    const resetButton = screen.getAllByText('Reset to default')[0]
    fireEvent.click(resetButton)

    await waitFor(() => expect(fontColorSetSpy).toHaveBeenCalledWith({ color: null }))
  })
})

describe('PrimaryColorPicker (accent-colour override)', () => {
  it('renders a Primary accent picker with a disabled Reset button when no override is set', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('primary-color-input') as HTMLInputElement
    await waitFor(() => expect(primaryColorGetSpy).toHaveBeenCalled())
    expect(input.value).toMatch(/^#[0-9a-f]{6}$/)
    const row = input.closest('div') as HTMLElement
    expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('changing the color input calls primaryColor.set() and invalidates the query', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('primary-color-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#402060' } })

    await waitFor(() => expect(primaryColorSetSpy).toHaveBeenCalledWith({ color: '#402060' }))
    await waitFor(() => expect((screen.getByTestId('primary-color-input') as HTMLInputElement).value).toBe('#402060'))
  })

  it('"Reset to default" calls primaryColor.set({ color: null })', async () => {
    currentPrimaryColor = { color: '#402060' }
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('primary-color-input') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('#402060'))
    const row = input.closest('div') as HTMLElement
    fireEvent.click(row.querySelector('button') as HTMLButtonElement)

    await waitFor(() => expect(primaryColorSetSpy).toHaveBeenCalledWith({ color: null }))
  })
})

describe('SecondaryColorPicker (accent-colour override)', () => {
  it('renders a Secondary accent picker with a disabled Reset button when no override is set', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('secondary-color-input') as HTMLInputElement
    await waitFor(() => expect(secondaryColorGetSpy).toHaveBeenCalled())
    expect(input.value).toMatch(/^#[0-9a-f]{6}$/)
    const row = input.closest('div') as HTMLElement
    expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('changing the color input calls secondaryColor.set() and invalidates the query', async () => {
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('secondary-color-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#20a060' } })

    await waitFor(() => expect(secondaryColorSetSpy).toHaveBeenCalledWith({ color: '#20a060' }))
    await waitFor(() => expect((screen.getByTestId('secondary-color-input') as HTMLInputElement).value).toBe('#20a060'))
  })

  it('"Reset to default" calls secondaryColor.set({ color: null })', async () => {
    currentSecondaryColor = { color: '#20a060' }
    renderWithQuery(<BackgroundSection />)
    const input = await screen.findByTestId('secondary-color-input') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('#20a060'))
    const row = input.closest('div') as HTMLElement
    fireEvent.click(row.querySelector('button') as HTMLButtonElement)

    await waitFor(() => expect(secondaryColorSetSpy).toHaveBeenCalledWith({ color: null }))
  })
})
