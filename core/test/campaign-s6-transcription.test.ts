/**
 * S6 — TranscriptionProvider (whisperProvider) gating LOCKs.
 *
 * Extends transcription.test.ts: locks the no-audio-bytes-in-errors guarantee
 * and the invalid-JSON error branch. global fetch is stubbed; no real Whisper.
 *
 * Findings: S6-008 (no audio-byte leak in errors; invalid-JSON branch).
 * testing/findings/S6-voice-bible.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { whisperProvider, TranscriptionError } from '../src/transcription.js'
import { __resetConfigCache } from '../src/config-store.js'
import { db } from '../src/db.js'

function clearConfigTable() {
  db.prepare('DELETE FROM app_config').run()
}

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearConfigTable()
  __resetConfigCache()
})

// A recognizable audio payload — if any error message echoes the bytes, we catch it.
const SECRET_AUDIO = Buffer.from('SUPER-SECRET-AUDIO-BYTES-0xDEADBEEF')

describe('S6 whisperProvider — errors never leak the audio bytes', () => {
  it('network failure → TranscriptionError whose message excludes the audio payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9000')))
    let caught: unknown
    try {
      await whisperProvider.transcribe(SECRET_AUDIO, 'audio/webm')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TranscriptionError)
    expect((caught as Error).message).toContain('Whisper unreachable')
    expect((caught as Error).message).not.toContain('SUPER-SECRET-AUDIO-BYTES')
  })

  it('non-OK status → TranscriptionError carrying only the status, not the audio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response))
    let caught: unknown
    try {
      await whisperProvider.transcribe(SECRET_AUDIO, 'audio/webm')
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toContain('503')
    expect((caught as Error).message).not.toContain('SUPER-SECRET-AUDIO-BYTES')
  })
})

describe('S6 whisperProvider — invalid-JSON response branch', () => {
  it('200 with a body that fails to JSON-parse → TranscriptionError("not valid JSON")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response))

    await expect(
      whisperProvider.transcribe(SECRET_AUDIO, 'audio/webm'),
    ).rejects.toThrow(/not valid JSON/)
  })
})
