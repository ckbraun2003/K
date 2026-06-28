/**
 * Voice routes tests — POST /api/transcribe
 *
 * A bare Fastify instance is created with only `voiceRoutes` registered so we
 * exercise the handler in isolation (no auth hook, no other routes). The
 * TranscriptionProvider is swapped via the test seam so no network calls are
 * made. Audio bytes are never logged.
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
  db.prepare(`DELETE FROM app_config`).run()
}

// ── app factory ───────────────────────────────────────────────────────────────

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(voiceRoutes)
  return app
}

// A small valid audio buffer (8 bytes is enough for unit tests — we never
// validate the audio format in the route itself, that's the Whisper server's job).
const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
const HEADERS = { 'content-type': 'audio/webm' }

beforeEach(() => {
  clearConfigTable()
  __resetConfigCache()
  setVoiceEnabled(true)
  // Default mock provider: succeeds with { text: 'hello' }
  setTranscriptionProvider({ transcribe: vi.fn().mockResolvedValue({ text: 'hello' }) })
})

afterEach(() => {
  resetTranscriptionProvider()
  clearConfigTable()
  __resetConfigCache()
})

// ── Happy path ─────────────────────────────────────────────────────────────────

describe('POST /api/transcribe — happy path', () => {
  it('returns 200 { text } when voice is enabled and provider succeeds', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ text: 'hello' })
    } finally {
      await app.close()
    }
  })

  it('passes mime type (stripped of params) to provider', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'stripped' })
    setTranscriptionProvider({ transcribe: mockTranscribe })
    const app = await makeApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: { 'content-type': 'audio/webm; codecs=opus' },
      })
      expect(mockTranscribe).toHaveBeenCalledOnce()
      const [, mime] = mockTranscribe.mock.calls[0] as [Buffer, string]
      expect(mime).toBe('audio/webm')
    } finally {
      await app.close()
    }
  })

  it('accepts audio/ogg content-type', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: { 'content-type': 'audio/ogg' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('accepts audio/wav content-type', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: { 'content-type': 'audio/wav' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('accepts application/octet-stream content-type', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: { 'content-type': 'application/octet-stream' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

// ── Feature gate ───────────────────────────────────────────────────────────────

describe('POST /api/transcribe — voice disabled', () => {
  it('returns 503 when voiceEnabled() is false', async () => {
    setVoiceEnabled(false)
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ error: 'voice disabled' })
    } finally {
      await app.close()
    }
  })
})

// ── Provider error ─────────────────────────────────────────────────────────────

describe('POST /api/transcribe — provider throws', () => {
  it('returns 502 when provider throws TranscriptionError', async () => {
    setTranscriptionProvider({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError('Whisper unreachable: ECONNREFUSED')),
    })
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(502)
      expect(res.json()).toMatchObject({ error: /Whisper unreachable/ })
    } finally {
      await app.close()
    }
  })

  it('returns 502 on unexpected provider error', async () => {
    setTranscriptionProvider({
      transcribe: vi.fn().mockRejectedValue(new Error('unexpected')),
    })
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: AUDIO,
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(502)
    } finally {
      await app.close()
    }
  })
})

// ── Empty body ─────────────────────────────────────────────────────────────────

describe('POST /api/transcribe — empty body', () => {
  it('returns 400 when body is empty (zero-length buffer)', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: Buffer.alloc(0),
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'empty body' })
    } finally {
      await app.close()
    }
  })
})

// ── Oversized body ─────────────────────────────────────────────────────────────

describe('POST /api/transcribe — oversized body', () => {
  it('returns 413 when body exceeds the 25 MB cap', async () => {
    // 26 MB: exceeds the addContentTypeParser bodyLimit → Fastify returns 413.
    const oversized = Buffer.alloc(26 * 1024 * 1024)
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transcribe',
        payload: oversized,
        headers: HEADERS,
      })
      expect(res.statusCode).toBe(413)
    } finally {
      await app.close()
    }
  })
})
