/**
 * Kill/abort semantics of the Ollama agent loop (Lane B, wave B2).
 *
 * handle.kill is AbortController.abort() behind the supervisor's ActiveProc
 * interface: it must be idempotent, tolerate signal-name args (the SIGTERM →
 * SIGKILL escalation calls it twice), unblock a hung stream AND a hung tool
 * call, and ALWAYS leave the MCP clients closed — including when the loop
 * throws. done never rejects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { startOllamaAgentRun } from '../src/ollama-agent/loop.js'
import {
  fakeAssets,
  hangingMcpHandler,
  makeFakeMcpClient,
  makeFakeTransport,
  textChunk,
  toolCallChunk,
  usageChunk,
  type FakeTransport,
} from './helpers/ollama-fakes.js'

let worktree: string

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-kill-'))
})

afterEach(() => {
  try { fs.rmSync(worktree, { recursive: true, force: true }) } catch { /* win lock */ }
})

function start(
  transport: FakeTransport,
  cfg: Partial<Parameters<typeof startOllamaAgentRun>[0]> = {},
  deps: Partial<Parameters<typeof startOllamaAgentRun>[1]> = {},
) {
  const events: AgentEvent[] = []
  let seq = 0
  const handle = startOllamaAgentRun(
    {
      runId: uuid(),
      model: 'llama3.2',
      prompt: 'p',
      cwd: worktree,
      assets: fakeAssets(),
      nextSeq: () => seq++,
      onEvent: e => events.push(e),
      fsScope: 'worktree',
      ...cfg,
    },
    { transport, ...deps },
  )
  return { handle, events }
}

const mountedServer = (name: string) => ({
  name,
  sourceKind: 'k' as const,
  config: { command: 'x', args: [], env: {} },
  estTokens: null,
})

describe('kill', () => {
  it('kill mid-stream unblocks a hung chat and resolves exit 1 without an error event', async () => {
    const mcp = makeFakeMcpClient('kstore', [{ name: 't', inputSchema: { type: 'object' } }])
    const transport = makeFakeTransport([{ hang: true }])
    const { handle, events } = start(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore'],
        mcpServers: [mountedServer('kstore')],
      }),
    }, { connectMcp: async () => mcp })

    setTimeout(() => handle.kill('SIGTERM'), 50)
    expect(await handle.done).toEqual({ exitCode: 1 })
    // Operator kill is SILENT loop-side — 'killed' status is supervisor bookkeeping.
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(mcp.closed).toBe(true)
  })

  it('kill mid-tool-call unblocks a hung MCP dispatch', async () => {
    const mcp = makeFakeMcpClient(
      'kstore',
      [{ name: 'slow_op', inputSchema: { type: 'object', properties: {} } }],
      hangingMcpHandler(),
    )
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('mcp__kstore__slow_op', {}, 's-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('never reached'), usageChunk(1, 1)] },
    ])
    const { handle } = start(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore'],
        mcpServers: [mountedServer('kstore')],
      }),
    }, { connectMcp: async () => mcp })

    // Wait until the dispatch is actually in flight, then kill.
    const until = Date.now() + 5000
    while (mcp.calls.length === 0 && Date.now() < until) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(mcp.calls).toHaveLength(1)
    handle.kill()
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(mcp.closed).toBe(true)
  })

  it('double-kill is idempotent and tolerates signal-name args', async () => {
    const transport = makeFakeTransport([{ hang: true }])
    const { handle } = start(transport)
    handle.kill('SIGTERM')
    handle.kill('SIGKILL') // the supervisor's 3s escalation path calls again
    handle.kill()
    expect(await handle.done).toEqual({ exitCode: 1 })
  })

  it('a kill landing during MCP spawn short-circuits without ever calling the model', async () => {
    // The loop body runs synchronously up to its first await — with an MCP
    // server to spawn, that await point is where an early kill can land.
    const mcp = makeFakeMcpClient('kstore', [{ name: 't', inputSchema: { type: 'object' } }])
    const transport = makeFakeTransport([{ chunks: [textChunk('x'), usageChunk(1, 1)] }])
    const { handle } = start(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore'],
        mcpServers: [mountedServer('kstore')],
      }),
    }, {
      connectMcp: async () => {
        await new Promise(r => setTimeout(r, 30))
        return mcp
      },
    })
    handle.kill()
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(transport.requests).toHaveLength(0)
    expect(mcp.closed).toBe(true) // spawned-then-aborted client is still torn down
  })

  it('a kill during a SLOW MCP connect is honored promptly and silently', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('x'), usageChunk(1, 1)] }])
    const { handle, events } = start(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__slow'],
        mcpServers: [mountedServer('slow')],
      }),
    }, {
      // A server that takes forever to initialize — settles only on abort.
      connectMcp: (_name, _cfg, opts) =>
        new Promise((_, reject) => {
          if (opts?.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        }),
    })
    const started = Date.now()
    setTimeout(() => handle.kill(), 50)
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(Date.now() - started).toBeLessThan(2000) // prompt, not a 15s init timeout
    expect(transport.requests).toHaveLength(0) // model never called
    // No misleading "failed to start" noise for an operator kill.
    expect(events.some(e => e.type === 'system' && /failed to start/.test(e.text ?? ''))).toBe(false)
  })

  it('closes every MCP client when the loop THROWS (transport failure)', async () => {
    const a = makeFakeMcpClient('kstore', [{ name: 't1', inputSchema: { type: 'object' } }])
    const b = makeFakeMcpClient('logistics', [{ name: 't2', inputSchema: { type: 'object' } }])
    const clients: Record<string, typeof a> = { kstore: a, logistics: b }
    const transport = makeFakeTransport([{ error: new Error('boom mid-run') }])
    const { handle, events } = start(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore', 'mcp__logistics'],
        mcpServers: [mountedServer('kstore'), mountedServer('logistics')],
      }),
    }, { connectMcp: async name => clients[name] })

    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(events.some(e => e.type === 'error' && /boom mid-run/.test(e.text ?? ''))).toBe(true)
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
  })

  it('run timeout aborts exactly like a kill but reports the timeout', async () => {
    const mcp = makeFakeMcpClient('kstore', [{ name: 't', inputSchema: { type: 'object' } }])
    const transport = makeFakeTransport([{ hang: true }])
    const { handle, events } = start(transport, {
      runTimeoutMs: 120,
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore'],
        mcpServers: [mountedServer('kstore')],
      }),
    }, { connectMcp: async () => mcp })
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(events.some(e => e.type === 'error' && /timed out after 120ms/.test(e.text ?? ''))).toBe(true)
    expect(mcp.closed).toBe(true)
  })
})
