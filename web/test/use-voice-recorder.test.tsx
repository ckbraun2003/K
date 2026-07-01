/**
 * useVoiceRecorder — exercises the REAL hook against a faked global
 * `MediaRecorder` + `navigator.mediaDevices.getUserMedia`. No real mic/network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceRecorder } from '../src/lib/useVoiceRecorder'

class FakeTrack {
  stop = vi.fn()
  kind = 'audio'
}
class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() { return this.tracks }
}

// Emits two data chunks on stop() (so we can assert concatenation) then onstop.
class FakeMediaRecorder {
  static isTypeSupported = vi.fn((t: string) => t === 'audio/webm')
  static startCount = 0   // how many recorders actually went live (asserts the race)
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state = 'inactive'
  mimeType: string
  constructor(_stream: unknown, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? '' }
  start() { FakeMediaRecorder.startCount++; this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['foo']) })
    this.ondataavailable?.({ data: new Blob(['bar']) })
    this.onstop?.()
  }
}

let track: FakeTrack
let getUserMedia: ReturnType<typeof vi.fn>

function installMediaDevices(fn: unknown) {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: fn },
  })
}

beforeEach(() => {
  track = new FakeTrack()
  getUserMedia = vi.fn(async () => new FakeStream([track]))
  installMediaDevices(getUserMedia)
  // Reset the mime probe to the default each test (a test may override it).
  FakeMediaRecorder.isTypeSupported.mockImplementation((t: string) => t === 'audio/webm')
  FakeMediaRecorder.startCount = 0
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
})
afterEach(() => vi.unstubAllGlobals())

describe('useVoiceRecorder', () => {
  it('happy path: start → stop resolves a typed, concatenated Blob and frees the mic', async () => {
    const { result } = renderHook(() => useVoiceRecorder())
    expect(result.current.supported).toBe(true)

    await act(async () => { await result.current.start() })
    expect(result.current.recording).toBe(true)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })

    let blob: Blob | null = null
    await act(async () => { blob = await result.current.stop() })

    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.type).toBe('audio/webm')      // the chosen mime is applied
    expect(blob!.size).toBe(6)                  // 'foo' + 'bar' concatenated
    expect(track.stop).toHaveBeenCalled()       // mic released
    expect(result.current.recording).toBe(false)
  })

  it('DENIED: getUserMedia rejection sets a human error, stays not-recording, never throws', async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    const { result } = renderHook(() => useVoiceRecorder())

    // start() must resolve (not throw) on denial.
    await act(async () => { await result.current.start() })

    expect(result.current.error).toBe('Microphone permission denied')
    expect(result.current.recording).toBe(false)
    // stop() after a failed start yields null (nothing recorded).
    let blob: Blob | null = new Blob()
    await act(async () => { blob = await result.current.stop() })
    expect(blob).toBeNull()
  })

  it('supported is false when MediaRecorder is absent', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    const { result } = renderHook(() => useVoiceRecorder())
    expect(result.current.supported).toBe(false)
  })

  it('stop() before start() resolves null (defensive path)', async () => {
    const { result } = renderHook(() => useVoiceRecorder())
    let blob: Blob | null = new Blob()
    await act(async () => { blob = await result.current.stop() })
    expect(blob).toBeNull()
  })

  it('no supported mime → untyped octet-stream Blob (Safari path)', async () => {
    // isTypeSupported rejects every candidate → pickMime() returns '' → the Blob
    // is built untyped, so the POST falls back to application/octet-stream.
    FakeMediaRecorder.isTypeSupported.mockReturnValue(false)
    const { result } = renderHook(() => useVoiceRecorder())

    await act(async () => { await result.current.start() })
    let blob: Blob | null = null
    await act(async () => { blob = await result.current.stop() })

    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.type).toBe('')          // untyped → api uses octet-stream
    expect(blob!.size).toBe(6)
  })

  it('RACE: stop() while getUserMedia is still pending releases the mic and never goes live', async () => {
    // Defer getUserMedia so we can interleave stop() before it resolves — the real
    // bug (a fast release before a cached permission resolves). The default
    // FakeStream/getUserMedia resolves on a microtask and masks this.
    let resolveGUM!: () => void
    getUserMedia.mockImplementationOnce(
      () => new Promise<FakeStream>(res => { resolveGUM = () => res(new FakeStream([track])) }),
    )
    const { result } = renderHook(() => useVoiceRecorder())

    // Begin recording but DON'T await — getUserMedia is parked.
    let startPromise!: Promise<void>
    act(() => { startPromise = result.current.start() })

    // Release before the stream resolves → stop() must request an abort and bail.
    let stopped: Blob | null = new Blob()
    await act(async () => { stopped = await result.current.stop() })
    expect(stopped).toBeNull()

    // Now the permission resolves — start()'s continuation must tear the stream
    // down instead of going live: no recorder started, mic freed, not recording.
    await act(async () => { resolveGUM(); await startPromise })
    expect(FakeMediaRecorder.startCount).toBe(0)   // never went live
    expect(track.stop).toHaveBeenCalled()          // mic released
    expect(result.current.recording).toBe(false)
  })

  it('unmount mid-recording releases the mic (no leaked indicator)', async () => {
    const { result, unmount } = renderHook(() => useVoiceRecorder())
    await act(async () => { await result.current.start() })
    expect(result.current.recording).toBe(true)
    // Unmount without calling stop() — the cleanup effect must free the tracks.
    act(() => { unmount() })
    expect(track.stop).toHaveBeenCalled()
  })
})
