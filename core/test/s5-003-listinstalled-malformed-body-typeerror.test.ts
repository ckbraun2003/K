/**
 * REGRESSION — FAULT S5-003 (FIXED + promoted to gating, reboot wave F1.W4a).
 * Finding: testing/findings/S5-supervisor-providers-routing.md → row S5-003.
 *
 * Surface: core/src/ollama-client.ts `listInstalled` (lines ~48-56).
 *
 * Defect: after a 200 response, listInstalled does
 *   `const data = await res.json() ...; return (data.models ?? []).map(...)`
 * with no shape guard. The module header promises "Errors are typed:
 * OllamaNetworkError is thrown on any network failure or non-ok status ... Never
 * swallowed internally." But a well-formed 200 whose body is not the expected
 * object shape throws a RAW TypeError instead:
 *   - body `null`               → "Cannot read properties of null (reading 'models')"
 *   - body `{ models: {} }`     → "(data.models ?? []).map is not a function"
 *   - body `{ models: 'foo' }`  → "(data.models ?? []).map is not a function"
 * So callers that catch ONLY OllamaNetworkError (e.g. POST /api/ollama/active in
 * routes/ollama.ts) mislabel a parse bug as unreachability (502), and the typed-
 * error contract is broken.
 *
 * EXPECTED (post-fix): a malformed-but-200 body degrades to `[]` OR throws
 * OllamaNetworkError — never a raw TypeError → test goes green, moves to gating.
 * ACTUAL (today): listInstalled throws a TypeError → RED.
 *
 * Document-only: imports the real ollama-client; mocks global fetch; does not edit
 * core/src/**.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { listInstalled, OllamaNetworkError } from '../src/ollama-client.js'

afterEach(() => vi.unstubAllGlobals())

function ok200(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    { ok: true, status: 200, json: async () => body } as unknown as Response,
  ))
}

describe('S5-003 — listInstalled must not throw a raw TypeError on a malformed 200 body (RED)', () => {
  const cases: Array<[string, unknown]> = [
    ['null body', null],
    ['models is an object', { models: {} }],
    ['models is a string', { models: 'foo' }],
  ]

  for (const [label, body] of cases) {
    it(`${label}: returns [] or throws OllamaNetworkError, never TypeError`, async () => {
      ok200(body)
      const outcome = await listInstalled().then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e: e as Error }),
      )
      if (outcome.ok) {
        // Acceptable post-fix behavior: degrade to an empty list.
        expect(Array.isArray(outcome.v)).toBe(true)
      } else {
        // Acceptable post-fix behavior: a TYPED error, not a raw TypeError.
        // ACTUAL today: outcome.e is a TypeError → this assertion fails (red).
        expect(outcome.e).toBeInstanceOf(OllamaNetworkError)
        expect(outcome.e).not.toBeInstanceOf(TypeError)
      }
    })
  }
})
