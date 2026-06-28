/**
 * OllamaClient — typed HTTP wrapper around Ollama's REST API.
 *
 * All functions read baseUrl from the runtime config store (ollamaBaseUrl())
 * so the active URL is always current without a restart. Errors are typed:
 * OllamaNetworkError is thrown on any network failure or non-ok status, letting
 * callers decide how to surface them (degraded response, 502, etc.) without
 * having to inspect raw Error messages.
 *
 * No new runtime dependencies — uses the global `fetch` (Node 20+).
 */

import { ollamaBaseUrl } from './config-store.js'

export type InstalledModel = {
  name: string
  sizeBytes: number
  digest?: string
  modifiedAt?: string
}

export type PullProgress = {
  status: string
  total?: number
  completed?: number
}

/** Thrown on any Ollama HTTP or network failure. Never swallowed internally. */
export class OllamaNetworkError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'OllamaNetworkError'
  }
}

/** List installed models via GET /api/tags. */
export async function listInstalled(): Promise<InstalledModel[]> {
  const baseUrl = ollamaBaseUrl()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/tags`)
  } catch (e) {
    throw new OllamaNetworkError(`Ollama unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    throw new OllamaNetworkError(`Ollama /api/tags responded ${res.status}`)
  }
  const data = await res.json() as {
    models?: Array<{ name: string; size: number; digest?: string; modified_at?: string }>
  }
  return (data.models ?? []).map(m => ({
    name: m.name,
    sizeBytes: m.size,
    digest: m.digest,
    modifiedAt: m.modified_at,
  }))
}

/**
 * Pull a model by name with streaming NDJSON progress.
 *
 * Streams POST /api/pull and parses each NDJSON line, calling onProgress for
 * each. Resolves when the stream ends; rejects on { error } lines or network
 * failures. Honors signal — an abort causes fetch to reject, which propagates
 * to the caller as-is (callers can check AbortError.name === 'AbortError').
 */
export async function pull(
  name: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = ollamaBaseUrl()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal,
    })
  } catch (e) {
    throw new OllamaNetworkError(`Ollama /api/pull failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    throw new OllamaNetworkError(`Ollama /api/pull responded ${res.status}`)
  }
  if (!res.body) {
    throw new OllamaNetworkError('Ollama /api/pull returned no body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Tracks whether we are unwinding due to an error/abort. On a clean stream end
  // the body is already fully consumed, so we only cancel() the reader (tearing
  // down the underlying connection) when exiting early.
  let errored = false

  const abortError = () => new DOMException('The pull was aborted.', 'AbortError')

  // A single promise that rejects when the signal fires, raced against each
  // read() so a mid-stream abort unblocks a pending read() instead of hanging
  // until the body happens to yield. Hoisted (not per-iteration) so we register
  // exactly one abort listener. The no-op .catch prevents an unhandled rejection
  // if the abort fires after the loop has already exited normally.
  const abortRace: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(abortError())
        signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    : null
  abortRace?.catch(() => { /* handled in the read race */ })

  function parseLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return // ignore malformed lines
    }
    if (parsed.error) {
      throw new OllamaNetworkError(`Ollama pull error: ${String(parsed.error)}`)
    }
    onProgress({
      status: typeof parsed.status === 'string' ? parsed.status : String(parsed.status ?? ''),
      total: typeof parsed.total === 'number' ? parsed.total : undefined,
      completed: typeof parsed.completed === 'number' ? parsed.completed : undefined,
    })
  }

  try {
    while (true) {
      const { done, value } = abortRace
        ? await Promise.race([reader.read(), abortRace])
        : await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        parseLine(line)
      }
    }
    // Flush any remaining buffered content (line without trailing newline)
    if (buffer) parseLine(buffer)
  } catch (e) {
    errored = true
    throw e
  } finally {
    // On an error/abort exit, cancel the reader BEFORE releasing the lock so the
    // underlying connection is torn down instead of left draining the rest of
    // the body. cancel() also settles any read() left pending by the abort race,
    // which is what makes the subsequent releaseLock() legal.
    if (errored) {
      try { await reader.cancel() } catch { /* already closing */ }
    }
    try { reader.releaseLock() } catch { /* nothing pending / already released */ }
  }
}

/** Remove an installed model via DELETE /api/delete. */
export async function remove(name: string): Promise<void> {
  const baseUrl = ollamaBaseUrl()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  } catch (e) {
    throw new OllamaNetworkError(`Ollama /api/delete failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    throw new OllamaNetworkError(`Ollama /api/delete responded ${res.status}`)
  }
}
