/**
 * Campaign S5 — Ollama client NDJSON streaming + catalog disk-fit (LOCK).
 *
 * Extends `ollama-client.test.ts` / `ollama-catalog.test.ts`. Hammers the
 * untested NDJSON edges of pull() (chunk-split reassembly, CRLF, blank/malformed
 * lines, no-trailing-newline flush, numeric/absent status, stringified
 * total/completed dropped, error-line tears the reader down on an OPEN stream,
 * missing body) and the disk-fit boundaries (zero free, strict 5% headroom,
 * size-0). All network/FS is mocked — no real Ollama, no real statfs.
 *
 * Findings: S5-022 (pull NDJSON), S5-023 (listInstalled edge), S5-024 (disk-fit).
 * See testing/findings/S5-supervisor-providers-routing.md.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { listInstalled, pull, OllamaNetworkError } from '../src/ollama-client.js'
import { freeDiskBytes, fitsOnDisk } from '../src/ollama-catalog.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── helpers ──────────────────────────────────────────────────────────────────
function streamFromChunks(
  chunks: string[],
  opts: { close?: boolean; cancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  const { close = true, cancel } = opts
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      if (close) controller.close()
    },
    cancel,
  })
}
const pullResponse = (stream: ReadableStream<Uint8Array>): Response =>
  ({ ok: true, status: 200, body: stream }) as unknown as Response

async function collect(chunks: string[]): Promise<Array<{ status: string; total?: number; completed?: number }>> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pullResponse(streamFromChunks(chunks))))
  const progress: Array<{ status: string; total?: number; completed?: number }> = []
  await pull('m', p => progress.push(p))
  return progress
}

// ── pull() NDJSON streaming edges ──────────────────────────────────────────────
describe('S5 — pull() NDJSON streaming edges (S5-022)', () => {
  it('reassembles a JSON object split across two stream chunks', async () => {
    const p = await collect(['{"status":"downl', 'oading","total":100,"completed":50}\n'])
    expect(p).toHaveLength(1)
    expect(p[0]).toEqual({ status: 'downloading', total: 100, completed: 50 })
  })

  it('handles CRLF line endings (\\r stripped by trim)', async () => {
    const p = await collect(['{"status":"a"}\r\n{"status":"b"}\r\n'])
    expect(p.map(x => x.status)).toEqual(['a', 'b'])
  })

  it('skips blank lines mid-stream', async () => {
    const p = await collect(['{"status":"a"}\n\n   \n{"status":"b"}\n'])
    expect(p.map(x => x.status)).toEqual(['a', 'b'])
  })

  it('ignores a malformed (non-JSON) line and still emits the valid ones', async () => {
    const p = await collect(['{"status":"a"}\n', 'this is not json\n', '{"status":"b"}\n'])
    expect(p.map(x => x.status)).toEqual(['a', 'b'])
  })

  it('flushes a trailing line that has NO terminating newline (post-loop flush path)', async () => {
    const p = await collect(['{"status":"success"}']) // no \n
    expect(p).toHaveLength(1)
    expect(p[0].status).toBe('success')
  })

  it('coerces a numeric status to a string', async () => {
    const p = await collect(['{"status":5}\n'])
    expect(p[0].status).toBe('5')
  })

  it('drops STRINGIFIED total/completed to undefined (typeof number guard)', async () => {
    const p = await collect(['{"status":"downloading","total":"100","completed":"50"}\n'])
    expect(p[0]).toEqual({ status: 'downloading', total: undefined, completed: undefined })
  })

  it('an absent status becomes the empty string', async () => {
    const p = await collect(['{"total":10,"completed":3}\n'])
    expect(p[0]).toEqual({ status: '', total: 10, completed: 3 })
  })

  it('an {error} line on an OPEN stream throws OllamaNetworkError AND cancels the reader', async () => {
    const cancelSpy = vi.fn()
    // Single chunk carrying a progress line then an error line; the stream is
    // left OPEN so the error path is what tears the reader down (cancel fires).
    const stream = streamFromChunks(
      ['{"status":"pulling manifest"}\n{"error":"model not found"}\n'],
      { close: false, cancel: cancelSpy },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pullResponse(stream)))
    const err = await pull('ghost', vi.fn()).catch(e => e as Error)
    expect(err).toBeInstanceOf(OllamaNetworkError)
    expect((err as Error).message).toContain('model not found')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('throws OllamaNetworkError when the response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response))
    await expect(pull('m', vi.fn())).rejects.toThrow(OllamaNetworkError)
    await expect(pull('m', vi.fn())).rejects.toThrow(/no body/i)
  })
})

// ── listInstalled edge ─────────────────────────────────────────────────────────
describe('S5 — listInstalled tolerates a model row missing size (S5-023)', () => {
  it('maps a size-less model with sizeBytes undefined (no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ models: [{ name: 'x' }] }) } as unknown as Response,
    ))
    const models = await listInstalled()
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('x')
    expect(models[0].sizeBytes).toBeUndefined()
  })
})

// ── disk-fit boundaries ────────────────────────────────────────────────────────
describe('S5 — freeDiskBytes / fitsOnDisk boundaries (S5-024)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubStatfs = (bavail: number, bsize: number) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockResolvedValue({ bavail, bsize } as any)

  it('zero available blocks → 0 free → nothing fits, not even a 0-byte entry', async () => {
    stubStatfs(0, 4096)
    expect(await freeDiskBytes()).toBe(0)
    expect(await fitsOnDisk(1)).toBe(false)
    expect(await fitsOnDisk(0)).toBe(false) // 0 < 0*0.95 is false
  })

  it('zero block size → 0 free', async () => {
    stubStatfs(1000, 0)
    expect(await freeDiskBytes()).toBe(0)
    expect(await fitsOnDisk(1)).toBe(false)
  })

  it('5% headroom is a STRICT less-than at the exact boundary', async () => {
    stubStatfs(100, 1) // 100 bytes free → threshold = 95
    expect(await fitsOnDisk(95)).toBe(false) // 95 < 95 is false
    expect(await fitsOnDisk(94)).toBe(true)
    expect(await fitsOnDisk(96)).toBe(false)
  })

  it('a 0-byte model fits whenever there is any free space', async () => {
    stubStatfs(100, 1)
    expect(await fitsOnDisk(0)).toBe(true) // 0 < 95
  })

  it('statfs failure falls back to MAX_SAFE_INTEGER so any realistic size fits', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(fs.promises, 'statfs' as any).mockRejectedValue(new Error('ENOSYS'))
    expect(await freeDiskBytes()).toBe(Number.MAX_SAFE_INTEGER)
    expect(await fitsOnDisk(100 * 1024 * 1024 * 1024)).toBe(true)
  })
})
