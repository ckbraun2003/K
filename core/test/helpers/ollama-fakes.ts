/**
 * Shared fakes for the Ollama agent runtime tests (Lane B) — the loop's
 * injected-deps seam made concrete:
 *
 *   makeFakeTransport(turns)  — scripts /api/chat iteration by iteration and
 *                               records every request (messages, tools, options);
 *   makeFakeMcpClient(...)    — an in-memory McpClient with scripted tools,
 *                               recorded calls, and a closed flag;
 *   fakeAssets(...)           — a minimal ResolvedRunAssets;
 *   chunk builders            — textChunk / toolCallChunk / usageChunk.
 *
 * Kept OUT of vitest's test glob (helpers/, not *.test.ts) so it can be reused
 * by the B3 supervisor-integration tests and the conductor's cross-lane
 * integration tests.
 */

import type { McpClient, McpToolDef } from '../../src/mcp-client.js'
import type { ResolvedRunAssets } from '../../src/run-assets.js'
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaChatTransport,
  OllamaShowResult,
  OllamaToolCall,
} from '../../src/ollama-agent/transport.js'

// ─── chunk builders ───────────────────────────────────────────────────────────

export function textChunk(content: string): OllamaChatChunk {
  return { message: { role: 'assistant', content } }
}

export function toolCallChunk(
  name: string,
  args: Record<string, unknown> | string,
  id?: string,
): OllamaChatChunk {
  const call: OllamaToolCall = { ...(id ? { id } : {}), function: { name, arguments: args } }
  return { message: { role: 'assistant', content: '', tool_calls: [call] } }
}

export function usageChunk(promptEvalCount: number, evalCount: number): OllamaChatChunk {
  return { done: true, prompt_eval_count: promptEvalCount, eval_count: evalCount }
}

// ─── fake transport ───────────────────────────────────────────────────────────

export type FakeTurn =
  | { chunks: OllamaChatChunk[] }
  | { error: Error }
  /** Never yields — settles only when the signal aborts (kill/timeout tests). */
  | { hang: true }

export interface FakeTransport extends OllamaChatTransport {
  /** Deep-copied request per chat() call, in order. */
  requests: OllamaChatRequest[]
  showCalls: string[]
}

const abortError = (): DOMException => new DOMException('The chat stream was aborted.', 'AbortError')

export function makeFakeTransport(
  turns: FakeTurn[],
  show: OllamaShowResult = { capabilities: ['completion', 'tools'], contextLength: 8192 },
): FakeTransport {
  const requests: OllamaChatRequest[] = []
  const showCalls: string[] = []
  let i = 0
  return {
    requests,
    showCalls,
    chat(req, signal): AsyncIterable<OllamaChatChunk> {
      requests.push(JSON.parse(JSON.stringify(req)) as OllamaChatRequest)
      const turn = turns[i++]
      return (async function* () {
        if (signal?.aborted) throw abortError()
        if (!turn) throw new Error('fake transport: script exhausted — add more turns')
        if ('error' in turn) throw turn.error
        if ('hang' in turn) {
          await new Promise<never>((_, reject) => {
            if (signal?.aborted) return reject(abortError())
            signal?.addEventListener('abort', () => reject(abortError()), { once: true })
          })
        }
        for (const c of (turn as { chunks: OllamaChatChunk[] }).chunks) {
          if (signal?.aborted) throw abortError()
          yield c
        }
      })()
    },
    async show(model) {
      showCalls.push(model)
      return show
    },
  }
}

// ─── fake MCP client ──────────────────────────────────────────────────────────

export interface FakeMcpCall {
  tool: string
  args: Record<string, unknown>
  timeoutMs?: number
}

export interface FakeMcpClient extends McpClient {
  calls: FakeMcpCall[]
  closed: boolean
}

export function makeFakeMcpClient(
  name: string,
  tools: McpToolDef[],
  handler: (
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal },
  ) => Promise<{ content: unknown; isError: boolean }> = async (tool) => ({
    content: [{ type: 'text', text: `${tool} ok` }],
    isError: false,
  }),
): FakeMcpClient {
  const calls: FakeMcpCall[] = []
  let closed = false
  return {
    name,
    calls,
    get closed() {
      return closed
    },
    async listTools() {
      return tools
    },
    async callTool(tool, args, opts = {}) {
      calls.push({ tool, args, timeoutMs: opts.timeoutMs })
      return handler(tool, args, { signal: opts.signal })
    },
    async close() {
      closed = true
    },
    pid() {
      return closed ? null : 4242
    },
  }
}

/** A handler that never resolves until the signal aborts (kill-mid-tool tests). */
export function hangingMcpHandler(): (
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal },
) => Promise<{ content: unknown; isError: boolean }> {
  return (_tool, _args, opts) =>
    new Promise((_, reject) => {
      if (opts.signal?.aborted) return reject(abortError())
      opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
    })
}

// ─── fake assets ──────────────────────────────────────────────────────────────

export function fakeAssets(overrides: Partial<ResolvedRunAssets> = {}): ResolvedRunAssets {
  return {
    systemPrompt: 'L0 base prompt\n\n---\n\nL1 tier charter (test)',
    skills: [],
    mcpServers: [],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    disallowedTools: [],
    estTokens: { skillsMeta: 0, skillsBodies: 0, mcpTools: null },
    ...overrides,
  }
}
