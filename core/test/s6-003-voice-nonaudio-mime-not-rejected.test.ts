/**
 * REGRESSION — FAULT S6-003 (FIXED + promoted to gating, reboot wave F1.W3).
 * Finding: testing/findings/S6-voice-bible.md → row S6-003.
 *
 * POST /api/transcribe did NOT reject non-audio uploads. voiceRoutes only
 * REGISTERS a raw-buffer parser for AUDIO_TYPES (audio/webm|ogg|wav,
 * application/octet-stream); it never removes Fastify's DEFAULT parsers for
 * `application/json` and `text/plain`. So a request with content-type
 * `text/plain` (or `application/json`) was parsed by the default parser and its
 * (non-Buffer) body was forwarded to the transcription provider — contradicting
 * the route's own comment ("Any other content-type → 415"). Only a content-type
 * with NO registered parser (e.g. image/png) actually 415'd.
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
 *   Was:      200 (text/plain) with the provider invoked on a non-Buffer body.
 *
 * FIXED: the handler now validates the content-type up front — after the
 * voiceEnabled() 503 check and before touching the body — and returns 415 for any
 * MIME not in AUDIO_TYPES, so a default json/text parser body can never reach the
 * provider. This test asserts that EXPECTED (safe) behavior → now GREEN and gates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { voiceRoutes } from '../src/routes/voice.js'
import { setTranscriptionProvider, resetTranscriptionProvider } from '../src/transcription.js'
import { __resetConfigCache, setVoiceEnabled } from '../src/config-store.js'
import { db } from '../src/db.js'

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
