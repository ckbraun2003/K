/**
 * Voice routes — POST /api/transcribe
 *
 * Accepts raw binary audio from the browser, proxies it to the local Whisper
 * server via the TranscriptionProvider B-seam, and returns transcribed text.
 *
 * Security notes:
 *  - NOT auth-exempt: the global onRequest hook in index.ts requires a valid
 *    Bearer token for every path not in PUBLIC_PATHS. /api/transcribe is not
 *    in that set, so auth is enforced automatically.
 *  - 25 MB body cap: enforced at the Fastify layer via addContentTypeParser's
 *    bodyLimit option (→ 413 before the handler runs) and as a belt-and-
 *    suspenders check inside the handler.
 *  - Audio bytes are never logged at any point in this file or transcription.ts.
 *  - Only the four declared MIME types get a raw-buffer parser; the existing
 *    JSON parser (application/json) is NOT touched.
 */

import type { FastifyInstance } from 'fastify'
import { voiceEnabled } from '../config-store.js'
import { getTranscriptionProvider, TranscriptionError } from '../transcription.js'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // 25 MB

// Accepted inbound audio MIME types. Any other content-type → Fastify 415.
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/wav', 'application/octet-stream']

export async function voiceRoutes(app: FastifyInstance) {
  // Register a raw-buffer body parser for audio MIME types only.
  // bodyLimit caps the inbound stream; Fastify returns 413 automatically when
  // exceeded. This does not touch application/json used by other routes.
  app.addContentTypeParser(
    AUDIO_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES },
    (_req, body, done) => done(null, body),
  )

  // ── POST /api/transcribe ──────────────────────────────────────────────────

  app.post('/api/transcribe', async (req, reply) => {
    // Feature gate: 503 when voice is disabled in config.
    if (!voiceEnabled()) {
      return reply.status(503).send({ error: 'voice disabled' })
    }

    const body = req.body as Buffer | null

    // Empty body guard (missing or zero-length payload).
    if (!body || body.length === 0) {
      return reply.status(400).send({ error: 'empty body' })
    }

    // Belt-and-suspenders size check (primary enforcement is addContentTypeParser
    // bodyLimit, but guard again here in case Content-Length was wrong/absent).
    if (body.length > MAX_BODY_BYTES) {
      return reply.status(413).send({ error: 'audio too large (max 25 MB)' })
    }

    // Strip MIME parameters (e.g. "audio/webm; codecs=opus") before forwarding.
    const contentType = req.headers['content-type'] ?? 'application/octet-stream'
    const mime = contentType.split(';')[0].trim()

    try {
      const result = await getTranscriptionProvider().transcribe(body, mime)
      return reply.send({ text: result.text })
    } catch (e) {
      if (e instanceof TranscriptionError) {
        // Upstream Whisper failed or was unreachable — standard 502 proxy error.
        return reply.status(502).send({ error: e.message })
      }
      // Unexpected error — log it (without the audio body) and return 502.
      app.log.error('[voice] unexpected transcription error: ' + (e instanceof Error ? e.message : String(e)))
      return reply.status(502).send({ error: 'transcription failed' })
    }
  })
}
