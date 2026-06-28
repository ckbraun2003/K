/**
 * TranscriptionProvider B-seam tests.
 *
 * global `fetch` is stubbed so no real Whisper server is needed.
 * Audio bytes are never logged — tests only assert shape, not bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  whisperProvider,
  TranscriptionError,
  probeWhisper,
  setTranscriptionProvider,
  resetTranscriptionProvider,
  getTranscriptionProvider,
} from '../src/transcription.js'
import { __resetConfigCache } from '../src/config-store.js'
import { db } from '../src/db.js'

/** Clear the app_config table so config-store reads fall through to env/defaults. */
function clearConfigTable() {
  db.prepare('DELETE FROM app_config').run()
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response)
}

// Ensure no DB state leaks from other tests (e.g. config-store persistence tests).
beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetTranscriptionProvider()
  clearConfigTable()
  __resetConfigCache()
  delete process.env.WHISPER_BASE_URL
  delete process.env.WHISPER_MODEL
})

// ── whisperProvider.transcribe ─────────────────────────────────────────────────

describe('whisperProvider.transcribe — happy path', () => {
  it('POSTs multipart to /v1/audio/transcriptions and returns { text }', async () => {
    const mockFetch = makeFetch(200, { text: 'hello world' })
    vi.stubGlobal('fetch', mockFetch)

    const audio = Buffer.from('fake-audio-bytes')
    const result = await whisperProvider.transcribe(audio, 'audio/webm')

    expect(result).toEqual({ text: 'hello world' })

    // Verify URL
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/audio/transcriptions')

    // Verify it is a POST with a FormData body (not JSON)
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)

    const form = init.body as FormData
    // `file` field must be present
    expect(form.has('file')).toBe(true)
    // `model` field must be present
    expect(form.has('model')).toBe(true)
    // `response_format` field must be present
    expect(form.has('response_format')).toBe(true)
  })

  it('uses WHISPER_BASE_URL and WHISPER_MODEL from env (via config-store)', async () => {
    process.env.WHISPER_BASE_URL = 'http://my-whisper:8080'
    process.env.WHISPER_MODEL = 'large-v3'
    __resetConfigCache()

    const mockFetch = makeFetch(200, { text: 'env model used' })
    vi.stubGlobal('fetch', mockFetch)

    await whisperProvider.transcribe(Buffer.from('x'), 'audio/wav')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('http://my-whisper:8080')
    expect((init.body as FormData).get('model')).toBe('large-v3')
  })
})

describe('whisperProvider.transcribe — error paths', () => {
  it('throws TranscriptionError when fetch rejects (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(
      whisperProvider.transcribe(Buffer.from('x'), 'audio/webm'),
    ).rejects.toThrow(TranscriptionError)

    await expect(
      whisperProvider.transcribe(Buffer.from('x'), 'audio/webm'),
    ).rejects.toThrow(/Whisper unreachable/)
  })

  it('throws TranscriptionError when Whisper returns non-OK status', async () => {
    vi.stubGlobal('fetch', makeFetch(500, {}))

    await expect(
      whisperProvider.transcribe(Buffer.from('x'), 'audio/webm'),
    ).rejects.toThrow(TranscriptionError)

    await expect(
      whisperProvider.transcribe(Buffer.from('x'), 'audio/webm'),
    ).rejects.toThrow(/500/)
  })

  it('TranscriptionError is instanceof TranscriptionError', async () => {
    vi.stubGlobal('fetch', makeFetch(502, {}))
    try {
      await whisperProvider.transcribe(Buffer.from('x'), 'audio/webm')
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TranscriptionError)
    }
  })
})

// ── probeWhisper ─────────────────────────────────────────────────────────────

describe('probeWhisper', () => {
  it('returns true when GET /health responds 200', async () => {
    vi.stubGlobal('fetch', makeFetch(200, {}))
    expect(await probeWhisper('http://localhost:9000')).toBe(true)
  })

  it('returns false when GET /health responds non-OK', async () => {
    vi.stubGlobal('fetch', makeFetch(503, {}))
    expect(await probeWhisper('http://localhost:9000')).toBe(false)
  })

  it('returns false when fetch throws (server not running)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await probeWhisper('http://localhost:9000')).toBe(false)
  })

  it('probes ${baseUrl}/health', async () => {
    const mockFetch = makeFetch(200, {})
    vi.stubGlobal('fetch', mockFetch)
    await probeWhisper('http://whisper:9000')
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toBe('http://whisper:9000/health')
  })
})

// ── test seam ─────────────────────────────────────────────────────────────────

describe('setTranscriptionProvider / resetTranscriptionProvider', () => {
  it('swaps the active provider', () => {
    const mock = { transcribe: vi.fn() }
    setTranscriptionProvider(mock)
    expect(getTranscriptionProvider()).toBe(mock)
  })

  it('resetTranscriptionProvider restores whisperProvider', () => {
    const mock = { transcribe: vi.fn() }
    setTranscriptionProvider(mock)
    resetTranscriptionProvider()
    expect(getTranscriptionProvider()).toBe(whisperProvider)
  })
})
