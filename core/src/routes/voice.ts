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
 *  - Only the four declared MIME types get a raw-buffer parser; the handler
 *    rejects any other (non-audio) content-type with 415 before forwarding, so a
 *    default json/text parser body can never reach the provider.
 */

import type { FastifyInstance } from 'fastify'
import { voiceEnabled } from '../config-store.js'
import { getTranscriptionProvider, TranscriptionError } from '../transcription.js'
import { sendError } from './http-errors.js'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // 25 MB

// Accepted inbound audio MIME types. The handler 415s any other content-type.
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
    // Feature gate: 503 when voice is disabled in config. Envelope standardized via
    // sendError (F-028/F-021) — same status + message, now the shared { error } shape.
    if (!voiceEnabled()) {
      return sendError(reply, 503, 'voice disabled')
    }

    // Reject non-audio content-types (415) BEFORE touching the body or provider,
    // so a default json/text parser body can never reach Whisper. (Fastify's
    // default text/json parsers still buffer the rejected body first, but that is
    // bounded by Fastify's own body limit and the 415 short-circuits before any
    // provider call or Buffer expansion — no 100 MB Uint8Array path is reachable.)
    // Strip MIME parameters (e.g. "audio/webm; codecs=opus") and default a missing
    // content-type to the allowed octet-stream path.
    const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
    if (!AUDIO_TYPES.includes(mime)) {
      return sendError(reply, 415, 'unsupported media type (audio only)')
    }

    const body = req.body as Buffer | null

    // Empty body guard (missing or zero-length payload).
    if (!body || body.length === 0) {
      return sendError(reply, 400, 'empty body')
    }

    // Belt-and-suspenders size check (primary enforcement is addContentTypeParser
    // bodyLimit, but guard again here in case Content-Length was wrong/absent).
    if (body.length > MAX_BODY_BYTES) {
      return sendError(reply, 413, 'audio too large (max 25 MB)')
    }

    try {
      const result = await getTranscriptionProvider().transcribe(body, mime)
      return reply.send({ text: result.text })
    } catch (e) {
      if (e instanceof TranscriptionError) {
        // Upstream Whisper failed or was unreachable — standard 502 proxy error.
        return sendError(reply, 502, e.message)
      }
      // Unexpected error — log it (without the audio body) and return 502.
      app.log.error('[voice] unexpected transcription error: ' + (e instanceof Error ? e.message : String(e)))
      return sendError(reply, 502, 'transcription failed')
    }
  })
}
