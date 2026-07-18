/**
 * useBackgroundImageUrl — the shared authenticated-blob → object-URL hook behind
 * both <Background/> and the Appearance preview. Direct-hook coverage for the two
 * INT.3-review nits: it must NOT fetch when the kind isn't `image` (M2), and a
 * re-upload must clear the stale (already-revoked) URL before the new fetch
 * resolves rather than briefly rendering a revoked blob (M3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { BackgroundKind } from '@k/shared'
import { useBackgroundImageUrl } from '../src/lib/useBackgroundImageUrl'

const { mockImageBlob } = vi.hoisted(() => ({ mockImageBlob: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { settings: { background: { imageBlob: mockImageBlob } } },
}))

function Probe({ kind, version }: { kind: BackgroundKind; version: number | null }) {
  const url = useBackgroundImageUrl(kind, version)
  return <div data-testid="url">{url ?? 'null'}</div>
}

let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockImageBlob.mockReset()
  let n = 0
  createSpy = vi.fn(() => `blob:mock-${++n}`)
  revokeSpy = vi.fn()
  // jsdom implements neither for Blob — stub on the real URL constructor.
  URL.createObjectURL = createSpy
  URL.revokeObjectURL = revokeSpy
})
afterEach(() => {
  cleanup()
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.createObjectURL
  // @ts-expect-error test-only cleanup of the stub added above
  delete URL.revokeObjectURL
})

describe('useBackgroundImageUrl', () => {
  it('does NOT fetch when kind !== image, even if an image exists (M2)', async () => {
    render(<Probe kind="gradient" version={5} />)
    // Let any (unwanted) async settle.
    await Promise.resolve()
    expect(mockImageBlob).not.toHaveBeenCalled()
    expect(screen.getByTestId('url').textContent).toBe('null')
  })

  it('fetches the blob and exposes an object URL when kind === image', async () => {
    mockImageBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    render(<Probe kind="image" version={1} />)
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('blob:mock-1'))
    expect(mockImageBlob).toHaveBeenCalledWith(1)
  })

  it('re-upload clears the stale URL and revokes it before the new fetch resolves (M3)', async () => {
    mockImageBlob.mockResolvedValueOnce(new Blob(['a'], { type: 'image/png' }))
    const { rerender } = render(<Probe kind="image" version={1} />)
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('blob:mock-1'))

    // Second version: a fetch we hold pending, so we can observe the in-flight window.
    let resolve2: (b: Blob) => void = () => {}
    mockImageBlob.mockImplementationOnce(() => new Promise<Blob>(r => { resolve2 = r }))
    rerender(<Probe kind="image" version={2} />)

    // M3: while the new fetch is pending the hook exposes null — never the
    // revoked blob:mock-1 — and the prior object URL was revoked.
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('null'))
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-1')

    resolve2(new Blob(['b'], { type: 'image/png' }))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('blob:mock-2'))
    expect(mockImageBlob).toHaveBeenLastCalledWith(2)
  })
})
