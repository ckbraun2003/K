/**
 * S6 — Voice route (POST /api/transcribe) gating LOCKs.
 *
 * Extends voice-routes.test.ts with the gate-leak, degrade-never-500, and
 * transcript-transport vectors. The TranscriptionProvider is swapped via the
 * test seam so no network / no Whisper is touched. Audio bytes are never logged.
 *
 * Findings: S6-005 (gate: provider never called / no leak), S6-006 (unexpected
 * error → generic 502, never 500), S6-007 (transcript verbatim in JSON, inert).
 * testing/findings/S6-voice-bible.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { voiceRoutes } from '../src/routes/voice.js'
import {
  setTranscriptionProvider,
  resetTranscriptionProvider,
  TranscriptionError,
} from '../src/transcription.js'
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

const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
const HEADERS = { 'content-type': 'audio/webm' }

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  setVoiceEnabled(true)
  setTranscriptionProvider({ transcribe: vi.fn().mockResolvedValue({ text: 'hello' }) })
})

afterEach(() => {
  resetTranscriptionProvider()
  clearConfigTable()
  __resetConfigCache()
})

// ── Gate: disabled voice never reaches the provider (no proxy attempt / leak) ───

describe('S6 /api/transcribe — gate leak: provider is never invoked when disabled', () => {
  it('voice disabled → 503 AND the transcription provider is NOT called', async () => {
    const spy = vi.fn().mockResolvedValue({ text: 'should-not-run' })
    setTranscriptionProvider({ transcribe: spy })
    setVoiceEnabled(false)
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: AUDIO, headers: HEADERS })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ error: 'voice disabled' })
      // No proxy to Whisper happened → nothing could have leaked a key/url/audio.
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

// ── Degrade: every error path returns a clean 502, never a 500 / crash ───────────

describe('S6 /api/transcribe — degrade: provider failures never 500', () => {
  it('an UNEXPECTED (non-Transcription) error → 502 with a GENERIC message (no internal detail leak)', async () => {
    setTranscriptionProvider({
      transcribe: vi.fn().mockRejectedValue(new Error('ECONNREFUSED secret-internal-detail')),
    })
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: AUDIO, headers: HEADERS })
      expect(res.statusCode).toBe(502)
      // Generic message — the raw internal error text is NOT echoed to the client.
      expect(res.json()).toEqual({ error: 'transcription failed' })
      expect(res.payload).not.toContain('secret-internal-detail')
    } finally {
      await app.close()
    }
  })

  it('a TranscriptionError surfaces its (safe) message at 502, never 500', async () => {
    setTranscriptionProvider({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError('Whisper unreachable: connect ECONNREFUSED')),
    })
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: AUDIO, headers: HEADERS })
      expect(res.statusCode).toBe(502)
      expect(res.json().error).toContain('Whisper unreachable')
    } finally {
      await app.close()
    }
  })
})

// ── Transport: transcript is returned verbatim inside an inert JSON string ───────

describe('S6 /api/transcribe — transcript transport is inert JSON', () => {
  it('a transcript containing HTML/script is returned verbatim in the JSON text field (not rendered)', async () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)>'
    setTranscriptionProvider({ transcribe: vi.fn().mockResolvedValue({ text: evil }) })
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: AUDIO, headers: HEADERS })
      expect(res.statusCode).toBe(200)
      // Transport is application/json — the payload is a JSON string, never HTML.
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.json()).toEqual({ text: evil })
    } finally {
      await app.close()
    }
  })
})
