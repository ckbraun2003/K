/**
 * Ollama routes tests — bare Fastify instance with ollama-client mocked so
 * no real Ollama is needed. eventBus.broadcast is spied on to verify WS
 * progress emissions from the async pull path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { eventBus } from '../src/events.js'
import { __resetConfigCache } from '../src/config-store.js'

// ── mock ollama-client ────────────────────────────────────────────────────────
// The route imports OllamaNetworkError and uses instanceof, so the class must
// come from the same (mocked) module that the route imports.

vi.mock('../src/ollama-client.js', () => {
  class OllamaNetworkError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'OllamaNetworkError'
    }
  }
  return {
    OllamaNetworkError,
    listInstalled: vi.fn(),
    pull: vi.fn(),
    remove: vi.fn(),
  }
})

// ── mock ollama-catalog ───────────────────────────────────────────────────────

vi.mock('../src/ollama-catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ollama-catalog.js')>(
    '../src/ollama-catalog.js',
  )
  return {
    ...actual,
    freeDiskBytes: vi.fn().mockResolvedValue(50 * 1024 * 1024 * 1024), // 50 GB
    fitsOnDisk: vi.fn().mockResolvedValue(true),
  }
})

import {
  listInstalled,
  pull as pullModel,
  remove,
  OllamaNetworkError,
} from '../src/ollama-client.js'
import { ollamaRoutes, __resetActivePulls } from '../src/routes/ollama.js'

const mockListInstalled = vi.mocked(listInstalled)
const mockPull = vi.mocked(pullModel)
const mockRemove = vi.mocked(remove)

// ── app factory ───────────────────────────────────────────────────────────────

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(ollamaRoutes)
  return app
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  __resetActivePulls()
  __resetConfigCache()
})

// ── GET /api/ollama/models ────────────────────────────────────────────────────

describe('GET /api/ollama/models', () => {
  it('returns installed list and active model', async () => {
    mockListInstalled.mockResolvedValue([
      { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
      { name: 'mistral:7b', sizeBytes: 4_100_000_000 },
    ])
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/ollama/models' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Array.isArray(body.installed)).toBe(true)
      expect(body.installed).toHaveLength(2)
      expect(body.installed[0].name).toBe('llama3.2:3b')
      expect(typeof body.active).toBe('string')
      expect(body.degraded).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('returns degraded:true when Ollama is unreachable (200)', async () => {
    mockListInstalled.mockRejectedValue(new OllamaNetworkError('ECONNREFUSED'))
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/ollama/models' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.installed).toEqual([])
      expect(body.degraded).toBe(true)
      expect(typeof body.active).toBe('string')
    } finally {
      await app.close()
    }
  })
})

// ── GET /api/ollama/catalog ───────────────────────────────────────────────────

describe('GET /api/ollama/catalog', () => {
  it('annotates CATALOG entries with installed and fitsOnDisk', async () => {
    mockListInstalled.mockResolvedValue([{ name: 'llama3.2:3b', sizeBytes: 2_000_000_000 }])
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/ollama/catalog' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        items: Array<{ name: string; installed: boolean; fitsOnDisk: boolean }>
        freeDiskBytes: number
      }
      expect(Array.isArray(body.items)).toBe(true)
      expect(typeof body.freeDiskBytes).toBe('number')

      const llama = body.items.find(i => i.name === 'llama3.2:3b')
      const qwen = body.items.find(i => i.name === 'qwen2.5:0.5b')
      expect(llama?.installed).toBe(true)
      expect(qwen?.installed).toBe(false)
      expect(llama?.fitsOnDisk).toBe(true)
    } finally {
      await app.close()
    }
  })
})

// ── POST /api/ollama/pull ─────────────────────────────────────────────────────

describe('POST /api/ollama/pull', () => {
  it('returns 202 immediately and broadcasts ollama_pull messages', async () => {
    mockPull.mockImplementation(async (_name, onProgress) => {
      onProgress({ status: 'downloading', total: 1000, completed: 500 })
    })
    const broadcastSpy = vi.spyOn(eventBus, 'broadcast')
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull',
        payload: { name: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json().queued).toBe(true)

      // Wait for the async pull void IIFE to complete
      await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalled(), { timeout: 1000 })

      const calls = broadcastSpy.mock.calls.map(c => c[0])
      const progressCall = calls.find(m => m.type === 'ollama_pull' && !m.done)
      expect(progressCall).toBeDefined()
      expect(progressCall?.type).toBe('ollama_pull')
      expect(progressCall?.name).toBe('llama3.2:3b')
      expect(progressCall?.status).toBe('downloading')
      expect(progressCall?.percent).toBe(50) // 500/1000 * 100

      // Final done message
      const doneCall = calls.find(m => m.type === 'ollama_pull' && m.done)
      expect(doneCall).toBeDefined()
      expect(doneCall?.done).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('returns 400 on empty name', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull',
        payload: { name: '' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('returns 400 on invalid name charset', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull',
        payload: { name: 'bad name!!' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('broadcasts a final done:true error message when the async pull rejects', async () => {
    // The pull fails for a non-abort reason — the catch branch must emit a
    // terminal ollama_pull with done:true, status:'error', and the error text.
    mockPull.mockRejectedValue(new Error('disk full'))
    const broadcastSpy = vi.spyOn(eventBus, 'broadcast')
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull',
        payload: { name: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(202)

      await vi.waitFor(() => {
        const calls = broadcastSpy.mock.calls.map(c => c[0])
        expect(calls.some(m => m.type === 'ollama_pull' && m.done === true)).toBe(true)
      }, { timeout: 1000 })

      const doneCall = broadcastSpy.mock.calls
        .map(c => c[0])
        .find(m => m.type === 'ollama_pull' && m.done)
      expect(doneCall).toBeDefined()
      expect(doneCall?.type).toBe('ollama_pull')
      expect(doneCall?.name).toBe('llama3.2:3b')
      expect(doneCall?.status).toBe('error')
      expect(doneCall?.error).toContain('disk full')
    } finally {
      await app.close()
    }
  })
})

// ── POST /api/ollama/pull/cancel ──────────────────────────────────────────────

describe('POST /api/ollama/pull/cancel', () => {
  it('cancels an in-progress pull, returns 200, and emits a cancelled outcome', async () => {
    // The pull mock honors the AbortSignal: it stays pending until the signal
    // fires, then rejects — exercising the route IIFE's cancelled branch.
    mockPull.mockImplementation(
      (_name, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          if (signal) {
            if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }
        }),
    )
    const broadcastSpy = vi.spyOn(eventBus, 'broadcast')
    const app = await makeApp()
    try {
      // Awaiting the 202 is the deterministic sync point: the POST handler
      // registers the AbortController AND the void IIFE calls pull() (attaching
      // the mock's abort listener) synchronously before it returns — so by the
      // time we get here the cancel can abort it. No arbitrary setTimeout needed.
      const pullRes = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull',
        payload: { name: 'llama3.2:3b' },
      })
      expect(pullRes.statusCode).toBe(202)

      const cancelRes = await app.inject({
        method: 'POST',
        url: '/api/ollama/pull/cancel',
        payload: { name: 'llama3.2:3b' },
      })
      expect(cancelRes.statusCode).toBe(200)
      expect(cancelRes.json().cancelled).toBe('llama3.2:3b')

      // The abort must propagate into the IIFE and emit a cancelled terminal msg.
      await vi.waitFor(() => {
        const calls = broadcastSpy.mock.calls.map(c => c[0])
        expect(
          calls.some(
            m => m.type === 'ollama_pull' && m.done === true && m.status === 'cancelled',
          ),
        ).toBe(true)
      }, { timeout: 1000 })
    } finally {
      await app.close()
    }
  })
})

// ── POST /api/ollama/active ───────────────────────────────────────────────────

describe('POST /api/ollama/active', () => {
  it('sets the active model when it is installed (200)', async () => {
    mockListInstalled.mockResolvedValue([
      { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
    ])
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/active',
        payload: { model: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().active).toBe('llama3.2:3b')
    } finally {
      await app.close()
    }
  })

  it('returns 400 when the model is not installed', async () => {
    mockListInstalled.mockResolvedValue([
      { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
    ])
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/active',
        payload: { model: 'mistral:7b' }, // not in the installed list
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('model not installed')
    } finally {
      await app.close()
    }
  })

  it('returns 502 when Ollama is unreachable', async () => {
    mockListInstalled.mockRejectedValue(new OllamaNetworkError('ECONNREFUSED'))
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/active',
        payload: { model: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(502)
    } finally {
      await app.close()
    }
  })

  it('returns 400 on missing model field', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ollama/active',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

// ── DELETE /api/ollama/models ────────────────────────────────────────────────
// Name travels in the request body (not a `/:name` path param) so namespaced
// tags containing `/` are routable, consistent with the other mutating routes.

describe('DELETE /api/ollama/models', () => {
  it('removes the model and returns { removed: name }', async () => {
    mockRemove.mockResolvedValue(undefined)
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ollama/models',
        payload: { name: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().removed).toBe('llama3.2:3b')
      expect(mockRemove).toHaveBeenCalledWith('llama3.2:3b')
    } finally {
      await app.close()
    }
  })

  it('removes a namespaced (slash-containing) model name', async () => {
    mockRemove.mockResolvedValue(undefined)
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ollama/models',
        payload: { name: 'library/llama3.2:3b' },
      })
      expect(res.statusCode).toBe(200)
      expect(mockRemove).toHaveBeenCalledWith('library/llama3.2:3b')
    } finally {
      await app.close()
    }
  })

  it('returns 400 on an empty model name', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ollama/models',
        payload: { name: '' },
      })
      expect(res.statusCode).toBe(400)
      expect(mockRemove).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 400 on an invalid model-name charset', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ollama/models',
        payload: { name: 'bad name!!' },
      })
      expect(res.statusCode).toBe(400)
      expect(mockRemove).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 502 when Ollama is unreachable', async () => {
    mockRemove.mockRejectedValue(new OllamaNetworkError('unreachable'))
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ollama/models',
        payload: { name: 'llama3.2:3b' },
      })
      expect(res.statusCode).toBe(502)
    } finally {
      await app.close()
    }
  })
})
