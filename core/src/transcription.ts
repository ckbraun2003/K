/**
 * TranscriptionProvider B-seam — the swappable voice-input backend.
 *
 * The default implementation posts raw audio to a local, OpenAI-compatible
 * Whisper server using Node 20 global fetch + FormData + Blob. No new
 * runtime dependencies. Audio bytes are NEVER logged.
 *
 * Test seam: call setTranscriptionProvider() to swap in a mock; call
 * resetTranscriptionProvider() to restore the default.
 */

import { whisperBaseUrl, whisperModel } from './config-store.js'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<{ text: string }>
}

// ── Typed error ───────────────────────────────────────────────────────────────

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptionError'
    // Ensure instanceof works across compilation boundaries.
    Object.setPrototypeOf(this, TranscriptionError.prototype)
  }
}

// ── Probe ─────────────────────────────────────────────────────────────────────

/**
 * Probe Whisper reachability via GET /health (or /v1/models as fallback).
 * Short timeout; never throws — returns false on any error.
 */
export async function probeWhisper(
  baseUrl = whisperBaseUrl(),
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal }).finally(
      () => clearTimeout(t),
    )
    return res.ok
  } catch {
    return false
  }
}

// ── Default provider ──────────────────────────────────────────────────────────

/**
 * Post audio to `${whisperBaseUrl()}/v1/audio/transcriptions` as multipart
 * form-data using Node 20 global FormData + Blob. Field layout mirrors the
 * OpenAI audio-transcription API so any compatible local server (Whisper.cpp
 * server, faster-whisper-server, …) works as a drop-in.
 *
 * Throws TranscriptionError on network failure or non-OK HTTP — the route maps
 * this to 502. Audio bytes are never included in the error or any log line.
 */
export const whisperProvider: TranscriptionProvider = {
  async transcribe(audio: Buffer, mime: string): Promise<{ text: string }> {
    const url = `${whisperBaseUrl()}/v1/audio/transcriptions`
    const form = new FormData()
    // `file` field: the audio Blob with its MIME type and a synthetic filename
    // so the server can infer the container format when it needs one.
    // Wrap in Uint8Array: Buffer's ArrayBufferLike doesn't satisfy BlobPart in TS strict mode.
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'audio')
    form.append('model', whisperModel())
    form.append('response_format', 'json')

    let res: Response
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 30_000)
      res = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal }).finally(
        () => clearTimeout(t),
      )
    } catch (e) {
      // Network-level failure (ECONNREFUSED, timeout, …). Never log `audio`.
      throw new TranscriptionError(
        `Whisper unreachable: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    if (!res.ok) {
      throw new TranscriptionError(`Whisper returned ${res.status}`)
    }

    let json: { text: string }
    try {
      json = (await res.json()) as { text: string }
    } catch {
      throw new TranscriptionError('Whisper response was not valid JSON')
    }
    const text = typeof json?.text === 'string' ? json.text : ''
    return { text }
  },
}

// ── Test seam ─────────────────────────────────────────────────────────────────

let _provider: TranscriptionProvider = whisperProvider

/** Swap the active transcription provider. For tests only. */
export function setTranscriptionProvider(p: TranscriptionProvider): void {
  _provider = p
}

/** Reset the provider to the default whisperProvider. For tests only. */
export function resetTranscriptionProvider(): void {
  _provider = whisperProvider
}

/** Return the currently active provider (production: whisperProvider; tests: mock). */
export function getTranscriptionProvider(): TranscriptionProvider {
  return _provider
}
