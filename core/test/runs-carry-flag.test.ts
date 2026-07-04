/**
 * H8 — POST /api/runs threads the opt-in `carryWorkingTree` flag to startRun.
 *
 * The supervisor is mocked so no claude process spawns; we assert the route forwards
 * the flag verbatim (true when supplied, undefined when omitted → default clean-HEAD
 * behavior) and that the schema rejects a non-boolean. Mirrors runs-cwd.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

import { runsRoutes } from '../src/routes/runs.js'
import { startRun } from '../src/supervisor.js'

const startRunMock = vi.mocked(startRun)

async function makeApp() {
  const app = Fastify()
  await app.register(runsRoutes)
  return app
}

describe('POST /api/runs — carryWorkingTree threading (H8)', () => {
  beforeEach(() => startRunMock.mockClear())

  it('forwards carryWorkingTree:true to startRun', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/runs',
        payload: { prompt: 'hi', carryWorkingTree: true },
      })
      expect(res.statusCode).toBe(201)
      expect(startRunMock).toHaveBeenCalledTimes(1)
      expect(startRunMock.mock.calls[0][1]).toMatchObject({ carryWorkingTree: true })
    } finally {
      await app.close()
    }
  })

  it('defaults to undefined (byte-identical clean-HEAD path) when omitted', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { prompt: 'hi' } })
      expect(res.statusCode).toBe(201)
      expect(startRunMock).toHaveBeenCalledTimes(1)
      expect(startRunMock.mock.calls[0][1].carryWorkingTree).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('rejects a non-boolean carryWorkingTree with 400 (schema-validated at the boundary)', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/runs',
        payload: { prompt: 'hi', carryWorkingTree: 'yes' },
      })
      expect(res.statusCode).toBe(400)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})
