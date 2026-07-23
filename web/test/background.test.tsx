/**
 * <Background/> (usability-access P2.6 wallpaper UI) — renders the
 * operator's saved wallpaper (GET /api/settings/background): solid,
 * one of the static CSS gradient presets, or an authenticated-fetch
 * uploaded image. Replaces the old animated galaxy-canvas + Ambient-blobs
 * system: no canvas, no `requestAnimationFrame` loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockGet, mockImageBlob, mockFontColorGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockImageBlob: vi.fn(),
  mockFontColorGet: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    settings: {
      background: {
        get: mockGet,
        set: vi.fn(),
        uploadImage: vi.fn(),
        imageBlob: mockImageBlob,
      },
      fontColor: {
        get: mockFontColorGet,
        set: vi.fn(),
      },
    },
  },
}))

import Background from '../src/shell/Background'

function renderBg() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Background />
    </QueryClientProvider>,
  )
}

let createObjectUrlSpy: ReturnType<typeof vi.fn>
let revokeObjectUrlSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockGet.mockReset()
  mockImageBlob.mockReset()
  mockFontColorGet.mockReset()
  mockFontColorGet.mockResolvedValue({ settings: { color: null } })
  createObjectUrlSpy = vi.fn(() => 'blob:mock-object-url')
  revokeObjectUrlSpy = vi.fn()
  // jsdom doesn't implement createObjectURL/revokeObjectURL for Blob — stub
  // both directly on the real URL constructor (not a replacement global, so
  // `new URL(...)` elsewhere in the app is unaffected) and remove after.
  URL.createObjectURL = createObjectUrlSpy
  URL.revokeObjectURL = revokeObjectUrlSpy
  document.documentElement.style.removeProperty('--text')
})
afterEach(() => {
  cleanup()
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.createObjectURL
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.revokeObjectURL
  document.documentElement.style.removeProperty('--text')
})

describe('Background', () => {
  it('solid: renders app-background with data-variant=solid, painted via --bg-deep', async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null }, presets: [], kinds: [] })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('solid')
    })
    const root = screen.getByTestId('app-background') as HTMLElement
    expect(root.style.background).toContain('var(--bg-deep)')
  })

  it('while loading, degrades to solid (no flash of the wrong wallpaper)', () => {
    mockGet.mockReturnValue(new Promise(() => {})) // never resolves
    renderBg()
    expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('solid')
  })

  it("gradient: applies the .bg-gradient-<preset> class for the saved preset", async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'gradient', preset: 'dusk', imageVersion: null }, presets: [], kinds: [] })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('gradient')
    })
    expect(screen.getByTestId('app-background').className).toContain('bg-gradient-dusk')
  })

  it('gradient: falls back to the aurora preset when none is saved', async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'gradient', preset: null, imageVersion: null }, presets: [], kinds: [] })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').className).toContain('bg-gradient-aurora')
    })
  })

  it('image: fetches the authenticated blob and paints it as the background via an object URL', async () => {
    const blob = new Blob(['fake-bytes'], { type: 'image/png' })
    mockImageBlob.mockResolvedValue(blob)
    mockGet.mockResolvedValue({ settings: { kind: 'image', preset: null, imageVersion: 3 }, presets: [], kinds: [] })
    renderBg()

    await waitFor(() => expect(mockImageBlob).toHaveBeenCalledWith(3))
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('image')
    })
    expect(createObjectUrlSpy).toHaveBeenCalledWith(blob)
    const root = screen.getByTestId('app-background') as HTMLElement
    expect(root.style.backgroundImage).toContain('blob:mock-object-url')
  })

  it('image: revokes the object URL on unmount', async () => {
    const blob = new Blob(['fake-bytes'], { type: 'image/png' })
    mockImageBlob.mockResolvedValue(blob)
    mockGet.mockResolvedValue({ settings: { kind: 'image', preset: null, imageVersion: 1 }, presets: [], kinds: [] })
    const { unmount } = renderBg()

    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('image')
    })
    unmount()
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:mock-object-url')
  })

  it('never schedules a requestAnimationFrame loop (no canvas/animation left)', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null }, presets: [], kinds: [] })
    renderBg()
    await waitFor(() => {
      expect(screen.getByTestId('app-background').getAttribute('data-variant')).toBe('solid')
    })
    expect(rafSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-background').querySelector('canvas')).toBeNull()
    rafSpy.mockRestore()
  })

  it('font-colour: writes a saved hex to --text on the document root', async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null }, presets: [], kinds: [] })
    mockFontColorGet.mockResolvedValue({ settings: { color: '#ff00aa' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--text')).toBe('#ff00aa')
    })
  })

  it('font-colour: a null color removes any --text override (theme default applies)', async () => {
    document.documentElement.style.setProperty('--text', '#123456') // simulate a prior override
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null }, presets: [], kinds: [] })
    mockFontColorGet.mockResolvedValue({ settings: { color: null } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--text')).toBe('')
    })
  })
})
