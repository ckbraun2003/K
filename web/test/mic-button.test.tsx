/**
 * MicButton — hold-to-talk control. useVoiceRecorder + api are mocked so no mic
 * or network is touched; a fake recorder returns a Blob from stop().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// ── controllable fake recorder ──────────────────────────────────────────────────
const startSpy = vi.fn(async () => {})
const stopSpy = vi.fn(async () => new Blob(['x'], { type: 'audio/webm' }))
const recorderState = { supported: true, recording: false, error: null as string | null }
vi.mock('../src/lib/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    supported: recorderState.supported,
    recording: recorderState.recording,
    error: recorderState.error,
    start: startSpy,
    stop: stopSpy,
  }),
}))

// ── mocked api client ─────────────────────────────────────────────────────────
const transcribeSpy = vi.fn(async () => ({ text: 'hello world' }))
vi.mock('../src/lib/api', () => ({
  api: { voice: { transcribe: (b: Blob) => transcribeSpy(b) } },
}))

import MicButton from '../src/components/MicButton'

beforeEach(() => {
  startSpy.mockClear()
  stopSpy.mockClear()
  stopSpy.mockImplementation(async () => new Blob(['x'], { type: 'audio/webm' }))
  transcribeSpy.mockClear()
  transcribeSpy.mockImplementation(async () => ({ text: 'hello world' }))
  recorderState.supported = true
  recorderState.recording = false
  recorderState.error = null
})
afterEach(() => cleanup())

describe('MicButton', () => {
  it('pointerDown → pointerUp transcribes the blob and emits the text', async () => {
    const onTranscript = vi.fn()
    render(<MicButton onTranscript={onTranscript} />)
    const btn = screen.getByTestId('mic-button')

    fireEvent.pointerDown(btn)
    fireEvent.pointerUp(btn)

    await waitFor(() => expect(transcribeSpy).toHaveBeenCalledTimes(1))
    expect(transcribeSpy.mock.calls[0][0]).toBeInstanceOf(Blob)
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello world'))
  })

  it('disabled prop → button disabled and a pointerDown is a no-op', async () => {
    const onTranscript = vi.fn()
    render(<MicButton onTranscript={onTranscript} disabled />)
    const btn = screen.getByTestId('mic-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toContain('ENABLE_VOICE')

    fireEvent.pointerDown(btn)
    fireEvent.pointerUp(btn)
    expect(startSpy).not.toHaveBeenCalled()
    expect(transcribeSpy).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('unsupported recorder → disabled with an explanatory tooltip', () => {
    recorderState.supported = false
    render(<MicButton onTranscript={vi.fn()} />)
    const btn = screen.getByTestId('mic-button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toContain('not supported')
  })

  it('transcribe failure → no transcript, no unhandled rejection, button stays usable', async () => {
    transcribeSpy.mockRejectedValueOnce(new Error('502 upstream'))
    const onTranscript = vi.fn()
    render(<MicButton onTranscript={onTranscript} />)
    const btn = screen.getByTestId('mic-button') as HTMLButtonElement

    fireEvent.pointerDown(btn)
    fireEvent.pointerUp(btn)

    await waitFor(() => expect(transcribeSpy).toHaveBeenCalled())
    await waitFor(() => expect(btn.getAttribute('data-state')).toBe('error'))
    expect(onTranscript).not.toHaveBeenCalled()
    expect(btn.disabled).toBe(false) // reset to a usable state so the user can retry
  })
})
