/**
 * OllamaClient unit tests — all network calls are mocked via vi.stubGlobal.
 * No real Ollama instance is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listInstalled, pull, remove, OllamaNetworkError } from '../src/ollama-client.js'

// Each test stubs fetch and restores it after.
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a mock Response with a JSON body. */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response
}

/** Build a mock Response whose body is a ReadableStream of NDJSON text. */
function ndjsonResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const combined = lines.map(l => l.endsWith('\n') ? l : l + '\n').join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(combined))
      controller.close()
    },
  })
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
  } as unknown as Response
}

// ── listInstalled ────────────────────────────────────────────────────────────

describe('listInstalled', () => {
  it('maps Ollama /api/tags models to InstalledModel shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { name: 'llama3.2:3b', size: 2_000_000_000, digest: 'sha256:abc', modified_at: '2025-01-01T00:00:00Z' },
          { name: 'mistral:7b', size: 4_100_000_000, digest: 'sha256:def' },
        ],
      }),
    ))

    const models = await listInstalled()
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({
      name: 'llama3.2:3b',
      sizeBytes: 2_000_000_000,
      digest: 'sha256:abc',
      modifiedAt: '2025-01-01T00:00:00Z',
    })
    expect(models[1].name).toBe('mistral:7b')
    expect(models[1].sizeBytes).toBe(4_100_000_000)
  })

  it('returns an empty array when models list is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    const models = await listInstalled()
    expect(models).toEqual([])
  })

  it('throws OllamaNetworkError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(listInstalled()).rejects.toThrow(OllamaNetworkError)
    await expect(listInstalled()).rejects.toThrow('ECONNREFUSED')
  })

  it('throws OllamaNetworkError on non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)))
    await expect(listInstalled()).rejects.toThrow(OllamaNetworkError)
    await expect(listInstalled()).rejects.toThrow('500')
  })
})

// ── pull ─────────────────────────────────────────────────────────────────────

describe('pull', () => {
  it('parses multi-line NDJSON and calls onProgress for each line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', total: 1000, completed: 300 }),
        JSON.stringify({ status: 'downloading', total: 1000, completed: 700 }),
        JSON.stringify({ status: 'verifying sha256 digest' }),
        JSON.stringify({ status: 'success' }),
      ]),
    ))

    const progress: Array<{ status: string; total?: number; completed?: number }> = []
    await pull('llama3.2:3b', (p) => progress.push(p))

    expect(progress).toHaveLength(5)
    expect(progress[0].status).toBe('pulling manifest')
    expect(progress[1].status).toBe('downloading')
    expect(progress[1].total).toBe(1000)
    expect(progress[1].completed).toBe(300)
    expect(progress[4].status).toBe('success')
  })

  it('rejects with OllamaNetworkError on an {error} NDJSON line', async () => {
    // Use mockImplementation (not mockResolvedValue) so each fetch() call gets a
    // FRESH ReadableStream — a single stream is consumed on first getReader() use.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          ndjsonResponse([
            JSON.stringify({ status: 'pulling manifest' }),
            JSON.stringify({ error: 'model not found' }),
          ]),
        ),
      ),
    )

    const err = await pull('no-such-model', vi.fn()).catch(e => e as Error)
    expect(err).toBeInstanceOf(OllamaNetworkError)
    expect(err.message).toContain('model not found')
  })

  it('resolves cleanly when the stream ends without error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse([JSON.stringify({ status: 'success' })]),
    ))
    await expect(pull('llama3.2', vi.fn())).resolves.toBeUndefined()
  })

  it('rejects (wraps in OllamaNetworkError) when fetch throws on abort', async () => {
    const ctrl = new AbortController()
    ctrl.abort()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    ))

    await expect(pull('llama3.2', vi.fn(), ctrl.signal)).rejects.toThrow(OllamaNetworkError)
  })

  it('aborts mid-stream: rejects and cancels the reader when the signal fires during a pending read', async () => {
    const ctrl = new AbortController()
    const cancelSpy = vi.fn()
    // A body that never yields and never closes — reader.read() stays pending
    // until something cancels it. The underlying source's cancel() is our probe
    // that pull() tore the reader down (no connection leak) on abort.
    const stream = new ReadableStream<Uint8Array>({
      start() { /* never enqueue, never close */ },
      cancel: cancelSpy,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response))

    const pullPromise = pull('llama3.2', vi.fn(), ctrl.signal)
    // Fire the abort on a later macrotask, while reader.read() is still pending.
    setTimeout(() => ctrl.abort(), 5)

    const err = await pullPromise.catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('throws OllamaNetworkError when pull response is non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([], 404)))
    await expect(pull('missing', vi.fn())).rejects.toThrow(OllamaNetworkError)
    await expect(pull('missing', vi.fn())).rejects.toThrow('404')
  })
})

// ── remove ───────────────────────────────────────────────────────────────────

describe('remove', () => {
  it('issues DELETE /api/delete with the model name in the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', mockFetch)

    await remove('mistral:7b')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/delete$/)
    expect(opts.method).toBe('DELETE')
    expect(JSON.parse(opts.body as string)).toEqual({ name: 'mistral:7b' })
  })

  it('throws OllamaNetworkError on non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response))
    await expect(remove('ghost')).rejects.toThrow(OllamaNetworkError)
  })

  it('throws OllamaNetworkError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(remove('llama3.2')).rejects.toThrow(OllamaNetworkError)
  })
})
