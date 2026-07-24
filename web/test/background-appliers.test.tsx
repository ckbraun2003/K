/**
 * <Background/> colour appliers (ui-adjustments Round 4) — the primary/
 * secondary accent-colour overrides + the solid-background solidColor
 * override. Mirrors background.test.tsx's mock/render harness; the
 * font-colour applier + wallpaper-kind rendering already covered there stay
 * there — this file is scoped to the NEW Round 4 appliers only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ON_ACCENT_DARK, ON_ACCENT_LIGHT } from '../src/lib/tokens'

const { mockGet, mockImageBlob, mockFontColorGet, mockPrimaryColorGet, mockSecondaryColorGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockImageBlob: vi.fn(),
  mockFontColorGet: vi.fn(),
  mockPrimaryColorGet: vi.fn(),
  mockSecondaryColorGet: vi.fn(),
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
      primaryColor: {
        get: mockPrimaryColorGet,
        set: vi.fn(),
      },
      secondaryColor: {
        get: mockSecondaryColorGet,
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

beforeEach(() => {
  mockGet.mockReset()
  mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null, solidColor: null }, presets: [], kinds: [] })
  mockImageBlob.mockReset()
  mockFontColorGet.mockReset()
  mockFontColorGet.mockResolvedValue({ settings: { color: null } })
  mockPrimaryColorGet.mockReset()
  mockPrimaryColorGet.mockResolvedValue({ settings: { color: null } })
  mockSecondaryColorGet.mockReset()
  mockSecondaryColorGet.mockResolvedValue({ settings: { color: null } })
  document.documentElement.style.removeProperty('--primary')
  document.documentElement.style.removeProperty('--secondary')
  document.documentElement.style.removeProperty('--on-accent')
})
afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--primary')
  document.documentElement.style.removeProperty('--secondary')
  document.documentElement.style.removeProperty('--on-accent')
})

describe('Background — primary colour applier', () => {
  it('a dark primary hex sets --primary and derives a LIGHT --on-accent', async () => {
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: '#402060' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#402060')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#f2ecff')
  })

  it('a light primary hex sets --primary and derives a DARK --on-accent', async () => {
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: '#f0d0ff' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#f0d0ff')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#241640')
  })

  it('clearing the override (color: null) removes both --primary and --on-accent', async () => {
    document.documentElement.style.setProperty('--primary', '#402060') // simulate a prior override
    document.documentElement.style.setProperty('--on-accent', '#f2ecff')
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: null } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('')
  })
})

describe('Background — onAccentFor picks by actual contrast, not a luminance threshold', () => {
  // A fixed `L > 0.4` threshold picks the LOWER-contrast ink across the
  // mid-luminance band: this teal sits at L≈0.270, so a threshold would call
  // it "dark enough" to warrant LIGHT ink (2.84:1, fails WCAG AA) when DARK
  // ink actually wins (5.07:1). The contrast-against-both-inks approach gets
  // this right regardless of where the crossover point actually falls.
  it('a mid-luminance teal (#2f9e8f) resolves to the higher-contrast DARK ink (5.07:1 beats 2.84:1)', async () => {
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: '#2f9e8f' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#2f9e8f')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe(ON_ACCENT_DARK)
  })

  it('a light primary (#f0d0ff) still resolves to the DARK ink (unchanged from the threshold version)', async () => {
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: '#f0d0ff' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#f0d0ff')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe(ON_ACCENT_DARK)
  })

  it('a primary equal to the dark ink itself (#241640) resolves to the LIGHT ink (only real contrast available)', async () => {
    mockPrimaryColorGet.mockResolvedValue({ settings: { color: '#241640' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#241640')
    })
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe(ON_ACCENT_LIGHT)
  })
})

describe('Background — secondary colour applier', () => {
  it('a saved hex sets --secondary on the document root', async () => {
    mockSecondaryColorGet.mockResolvedValue({ settings: { color: '#20a060' } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--secondary')).toBe('#20a060')
    })
  })

  it('clearing the override (color: null) removes --secondary', async () => {
    document.documentElement.style.setProperty('--secondary', '#20a060') // simulate a prior override
    mockSecondaryColorGet.mockResolvedValue({ settings: { color: null } })
    renderBg()
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--secondary')).toBe('')
    })
  })
})

describe('Background — solid background solidColor override', () => {
  it('renders data-variant=solid with the background painted using the saved solidColor', async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null, solidColor: '#123456' }, presets: [], kinds: [] })
    renderBg()
    const root = screen.getByTestId('app-background') as HTMLElement
    expect(root.getAttribute('data-variant')).toBe('solid')
    await waitFor(() => {
      expect(root.style.background).toBe('rgb(18, 52, 86)')
    })
  })

  it('with no solidColor saved, falls back to var(--bg-deep)', async () => {
    mockGet.mockResolvedValue({ settings: { kind: 'solid', preset: null, imageVersion: null, solidColor: null }, presets: [], kinds: [] })
    renderBg()
    await waitFor(() => {
      const root = screen.getByTestId('app-background') as HTMLElement
      expect(root.style.background).toContain('var(--bg-deep)')
    })
  })
})
