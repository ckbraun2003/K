/**
 * OllamaChatTransport — the ONE I/O seam of the Ollama agent loop (D-072).
 *
 * loop.ts is pure orchestration (no fetch/spawn/DB); everything it needs from
 * the Ollama daemon flows through this interface:
 *
 *   chat(req, signal) — stream POST /api/chat as an AsyncIterable of NDJSON
 *                       chunks (tool_calls tolerated on ANY chunk — protocol
 *                       drift across Ollama versions).
 *   show(model)       — POST /api/show → { capabilities, contextLength? }
 *                       (the B4 capability probe: 'tools' membership decides
 *                       tool advertising; contextLength feeds the
 *                       context-pressure warning).
 *
 * `httpTransport(baseUrl)` is the production implementation: global fetch +
 * newline-delimited JSON with the SAME reader discipline as
 * ollama-client.ts::pull (single hoisted abort race so a mid-stream abort
 * unblocks a pending read(), cancel-before-releaseLock on early exit, tolerant
 * line parsing). An injected fake transport is the test seam for the loop,
 * supervisor-integration, and capability tests.
 */

/** One tool definition advertised to the model (OpenAI-style function shape). */
export interface OllamaToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** A tool call the model requested. `arguments` is usually a parsed object but
 *  some model/daemon combinations emit a JSON STRING — callers must tolerate
 *  both (the loop parses strings defensively). `id` is optional protocol drift:
 *  present on some versions, absent on others. */
export interface OllamaToolCall {
  id?: string
  function: {
    name: string
    arguments: Record<string, unknown> | string
  }
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant messages replayed into history carry their tool calls. */
  tool_calls?: OllamaToolCall[]
  /** tool messages: which tool produced this result (Ollama convention). */
  tool_name?: string
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaChatMessage[]
  tools?: OllamaToolDef[]
  /** Model options — the loop always sets num_ctx explicitly (D-072). */
  options?: Record<string, unknown>
}

/** One NDJSON chunk of a streamed /api/chat response. The FINAL chunk
 *  (done:true) carries usage (prompt_eval_count / eval_count); tool_calls may
 *  appear on ANY chunk. All fields optional — the transport never normalizes,
 *  the loop tolerates. */
export interface OllamaChatChunk {
  message?: {
    role?: string
    content?: string
    tool_calls?: OllamaToolCall[]
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

export interface OllamaShowResult {
  /** Model capability strings from /api/show (e.g. 'completion', 'tools').
   *  Empty array when the daemon predates the capabilities field. */
  capabilities: string[]
  /** The model's context window (model_info '<arch>.context_length'), when reported. */
  contextLength?: number
}

export interface OllamaChatTransport {
  chat(req: OllamaChatRequest, signal?: AbortSignal): AsyncIterable<OllamaChatChunk>
  show(model: string): Promise<OllamaShowResult>
}

/**
 * Typed transport failure. `status`/`body` are populated for a non-ok HTTP
 * response so the capability policy (B4) can detect the daemon's
 * "does not support tools" 400 and degrade in place; both are undefined for
 * pure network failures.
 */
export class OllamaTransportError extends Error {
  constructor(
    msg: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(msg)
    this.name = 'OllamaTransportError'
  }
}

/** Production transport over global fetch (Node 20+ — no new deps). */
export function httpTransport(baseUrl: string): OllamaChatTransport {
  return {
    chat(req, signal): AsyncIterable<OllamaChatChunk> {
      return streamChat(baseUrl, req, signal)
    },

    async show(model) {
      let res: Response
      try {
        res = await fetch(`${baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        })
      } catch (e) {
        throw new OllamaTransportError(
          `Ollama /api/show failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new OllamaTransportError(`Ollama /api/show responded ${res.status}`, res.status, body)
      }
      const data = (await res.json().catch(() => null)) as {
        capabilities?: unknown
        model_info?: Record<string, unknown>
      } | null
      const capabilities = Array.isArray(data?.capabilities)
        ? data.capabilities.filter((c): c is string => typeof c === 'string')
        : []
      // model_info keys are arch-prefixed ('llama.context_length', …) — scan for
      // the suffix rather than hardcoding an architecture.
      let contextLength: number | undefined
      const info = data?.model_info
      if (info && typeof info === 'object') {
        for (const [k, v] of Object.entries(info)) {
          if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
            contextLength = v
            break
          }
        }
      }
      return { capabilities, contextLength }
    },
  }
}

/** The streaming core of chat() — an async generator with pull()'s reader discipline. */
async function* streamChat(
  baseUrl: string,
  req: OllamaChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<OllamaChatChunk> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    })
  } catch (e) {
    // AbortError propagates as-is so the loop can distinguish kill from failure.
    if (e instanceof Error && e.name === 'AbortError') throw e
    throw new OllamaTransportError(
      `Ollama /api/chat failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new OllamaTransportError(`Ollama /api/chat responded ${res.status}`, res.status, body)
  }
  if (!res.body) {
    throw new OllamaTransportError('Ollama /api/chat returned no body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const abortError = () => new DOMException('The chat stream was aborted.', 'AbortError')

  // Same hoisted single-listener abort race as ollama-client.ts::pull — a
  // mid-stream abort unblocks a pending read() instead of waiting for the body
  // to yield. The no-op catch prevents an unhandled rejection if the abort
  // fires after the loop already exited. Unlike pull() (one-shot per user
  // action), chat() runs once per LOOP ITERATION against a run-lifetime signal,
  // so the listener is explicitly removed in the finally — otherwise every
  // iteration would stack one until the run ends.
  let onAbort: (() => void) | null = null
  const abortRace: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(abortError())
        onAbort = () => reject(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null
  abortRace?.catch(() => { /* handled in the read race */ })

  function parseChunk(line: string): OllamaChatChunk | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return null // tolerate malformed lines (protocol drift)
    }
    if (parsed.error) {
      throw new OllamaTransportError(`Ollama chat error: ${String(parsed.error)}`)
    }
    return parsed as OllamaChatChunk
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
        const chunk = parseChunk(line)
        if (chunk) yield chunk
      }
    }
    // Flush a final line without a trailing newline.
    if (buffer) {
      const chunk = parseChunk(buffer)
      if (chunk) yield chunk
    }
    finished = true
  } finally {
    // Any early exit — error, abort, or the CONSUMER breaking out of the
    // for-await (generator return) — cancels the reader BEFORE releasing the
    // lock so the connection tears down instead of draining the rest.
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (!finished) {
      try { await reader.cancel() } catch { /* already closing */ }
    }
    try { reader.releaseLock() } catch { /* nothing pending */ }
  }
}
