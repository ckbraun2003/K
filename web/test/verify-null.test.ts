/**
 * Task 11 Step 3 — verifyResult's tolerant unwrap (impressive-wave BE-3
 * contract): absent → 200 {result:null}; present may be a bare VerifyResult
 * or {result}. Both shapes must resolve through api.runs.verifyResult.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('verifyResult null contract', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('unwraps {result:null} to null and bare payloads to themselves', async () => {
    const payload = { runId: 'r', status: 'pass', reason: null, commands: [], scope: null, startedAt: 1, completedAt: 2 }
    const mk = (body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

    mk({ result: null })
    const { api } = await import('../src/lib/api')
    expect(await api.runs.verifyResult('r')).toBeNull()

    vi.restoreAllMocks()
    mk(payload)
    expect(await api.runs.verifyResult('r')).toMatchObject({ status: 'pass' })
  })
})
