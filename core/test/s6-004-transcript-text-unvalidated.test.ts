/**
 * REGRESSION — FAULT S6-004 (FIXED + promoted to gating, reboot wave F1.W4c).
 *
 * whisperProvider.transcribe relays the Whisper JSON response field with zero
 * validation: `return { text: json.text }`. The declared interface is
 * `Promise<{ text: string }>`, but when the server returns JSON WITHOUT a `text`
 * field (e.g. `{}` — a server keyed differently, an error envelope, or a
 * truncated body), `json.text` is `undefined`. The route then `reply.send({ text:
 * undefined })`, which Fastify serializes to `{}` — a 200 OK with NO `text`
 * field, silently. Non-string `text` (number/object/null) is likewise relayed
 * verbatim, breaking the `{ text: string }` contract.
 *
 *   Surface: core/src/transcription.ts :: whisperProvider.transcribe (line ~99).
 *
 *   Expected: transcribe always resolves to a STRING `text` (coerce a missing /
 *             non-string value to '' — or throw TranscriptionError), so the
 *             route never emits a 200 that lacks a string transcript.
 *   Actual:   `{ text: undefined }` (and `{ text: <number/object> }` verbatim).
 *
 * Asserts the EXPECTED (safe) behavior → RED. LATENT in normal prod (real
 * whisper.cpp / faster-whisper return `{text:"…"}`); reachable with a
 * misconfigured / different-keyed / compromised Whisper server — the `{}`→`{}`
 * silent-no-text case is the most plausible real one. fetch is stubbed; no real
 * Whisper.
 *
 * Finding row: testing/findings/S6-voice-bible.md  (S6-004)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { whisperProvider } from '../src/transcription.js'
import { __resetConfigCache } from '../src/config-store.js'
import { db } from '../src/db.js'

afterEach(() => {
  vi.restoreAllMocks()
  db.prepare('DELETE FROM app_config').run()
  __resetConfigCache()
})

function fetchReturning(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response)
}

/**
 * A SAFE fix is EITHER of the two the finding endorses: resolve with a string
 * `text` (coercion), OR reject (e.g. throw TranscriptionError). Accept both so
 * this test flips green whichever fix the operator picks — and stays RED now,
 * when transcribe RESOLVES with a non-string `text`.
 */
async function assertSafeTranscribe(body: unknown): Promise<void> {
  vi.stubGlobal('fetch', fetchReturning(body))
  let resolved: { text: unknown } | undefined
  let threw: unknown
  try {
    resolved = await whisperProvider.transcribe(Buffer.from('x'), 'audio/webm')
  } catch (e) {
    threw = e
  }
  if (threw !== undefined) {
    // Rejected instead of relaying junk — safe (TranscriptionError or similar).
    expect(threw).toBeInstanceOf(Error)
  } else {
    // Resolved — the contract requires a STRING text. CURRENT (fault): undefined
    // / a number → fails here → RED.
    expect(typeof resolved?.text).toBe('string')
  }
}

describe('S6-004: transcribe must always resolve a string `text` (or reject)', () => {
  it('a Whisper response with NO text field is coerced to a string OR rejected (never undefined)', async () => {
    await assertSafeTranscribe({}) // server omits `text`
  })

  it('a non-string `text` (number) is coerced to a string OR rejected, not relayed verbatim', async () => {
    await assertSafeTranscribe({ text: 12345 })
  })
})
