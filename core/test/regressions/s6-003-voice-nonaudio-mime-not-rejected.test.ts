/**
 * REGRESSION (red by design) — Finding S6-003.
 *
 * POST /api/transcribe does NOT reject non-audio uploads. voiceRoutes only
 * REGISTERS a raw-buffer parser for AUDIO_TYPES (audio/webm|ogg|wav,
 * application/octet-stream); it never removes Fastify's DEFAULT parsers for
 * `application/json` and `text/plain`. So a request with content-type
 * `text/plain` (or `application/json`) is parsed by the default parser and its
 * (non-Buffer) body is forwarded to the transcription provider — contradicting
 * the route's own comment ("Any other content-type → Fastify 415"). Only a
 * content-type with NO registered parser (e.g. image/png) actually 415s.
 *
 *   Surface: core/src/routes/voice.ts :: voiceRoutes / POST /api/transcribe.
 *
 *   Downstream hazard (same root cause): the forwarded body is not a Buffer, so
 *   the handler's empty/size guards (written for Buffer.length) are bypassed, and
 *   whisperProvider's `new Uint8Array(audio)` takes the LENGTH branch for a
 *   numeric string/number body — a ~9-byte `text/plain` body "100000000" expands
 *   to a 100 MB allocation, defeating the documented 25 MB cap.
 *
 *   Expected: a non-audio content-type is rejected (415) and the provider is
 *             NEVER invoked.
 *   Actual:   200 (text/plain) with the provider invoked on a non-Buffer body.
 *
 * Asserts the EXPECTED (safe) behavior → RED. Flips green when the route rejects
 * non-audio MIME types (e.g. removes the default text/json parsers for this route
 * or validates content-type in the handler before forwarding).
 *
 * Finding row: testing/findings/S6-voice-bible.md  (S6-003)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { voiceRoutes } from '../../src/routes/voice.js'
import { setTranscriptionProvider, resetTranscriptionProvider } from '../../src/transcription.js'
import { __resetConfigCache, setVoiceEnabled } from '../../src/config-store.js'
import { db } from '../../src/db.js'

function clearConfigTable() {
  db.prepare('DELETE FROM app_config').run()
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(voiceRoutes)
  return app
}

let providerSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  setVoiceEnabled(true)
  providerSpy = vi.fn().mockResolvedValue({ text: 'should-not-transcribe-non-audio' })
  setTranscriptionProvider({ transcribe: providerSpy })
})

afterEach(() => {
  resetTranscriptionProvider()
  clearConfigTable()
  __resetConfigCache()
})

describe('S6-003: non-audio MIME uploads must be rejected, never forwarded to the provider', () => {
  it('text/plain → 415 and the provider is NOT invoked', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: 'hello this is not audio',
        headers: { 'content-type': 'text/plain' },
      })
      // EXPECTED (safe): unsupported media type.
      expect(res.statusCode).toBe(415)
      // EXPECTED (safe): a non-audio body never reaches Whisper.
      expect(providerSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('application/json → 415 and the provider is NOT invoked', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: { not: 'audio' },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(415)
      expect(providerSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
