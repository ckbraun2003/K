/**
 * The Ollama agent loop's iteration protocol (Lane B, wave B2) — scripted fake
 * transport + fake MCP clients; REAL native tools against a temp worktree.
 *
 * Pins: single/parallel tool-call round trips, text-only exit 0, the iteration
 * cap, malformed-args / unknown-tool / ungranted-MCP rejection (fed back, never
 * executed), the 8k tool-message truncation, the run timeout, MCP degraded
 * spawn, and the repeated-identical-call warning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { startOllamaAgentRun, TOOL_RESULT_MESSAGE_CAP_CHARS } from '../src/ollama-agent/loop.js'
import type { OllamaAgentRunConfig } from '../src/ollama-agent/loop.js'
import {
  fakeAssets,
  makeFakeMcpClient,
  makeFakeTransport,
  textChunk,
  toolCallChunk,
  usageChunk,
  type FakeTransport,
} from './helpers/ollama-fakes.js'

let worktree: string
const tmpDirs: string[] = []

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-loop-'))
  tmpDirs.push(worktree)
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* win lock */ }
  }
})

type Session = {
  handle: ReturnType<typeof startOllamaAgentRun>
  events: AgentEvent[]
  transport: FakeTransport
}

function startSession(
  transport: FakeTransport,
  cfg: Partial<OllamaAgentRunConfig> = {},
  deps: Partial<Parameters<typeof startOllamaAgentRun>[1]> = {},
): Session {
  const events: AgentEvent[] = []
  let seq = 0
  const handle = startOllamaAgentRun(
    {
      runId: uuid(),
      model: 'llama3.2',
      prompt: 'do the task',
      cwd: worktree,
      assets: fakeAssets(),
      nextSeq: () => seq++,
      onEvent: e => events.push(e),
      fsScope: 'worktree',
      ...cfg,
    },
    { transport, ...deps },
  )
  return { handle, events, transport }
}

const toolMessages = (t: FakeTransport, reqIdx: number) =>
  t.requests[reqIdx].messages.filter(m => m.role === 'tool')

describe('iteration protocol', () => {
  it('round-trips a single tool call: dispatch, result message, exit 0', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'file-contents-42', 'utf8')
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('Read', { file_path: 'f.txt' }, 'call-1'), usageChunk(100, 20)] },
      { chunks: [textChunk('all done'), usageChunk(150, 5)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })

    // Second request carries the assistant tool_calls message + the tool result.
    expect(transport.requests).toHaveLength(2)
    const msgs = transport.requests[1].messages
    const assistant = msgs.find(m => m.role === 'assistant')!
    expect(assistant.tool_calls).toHaveLength(1)
    const tool = toolMessages(transport, 1)
    expect(tool).toHaveLength(1)
    expect(tool[0].content).toBe('file-contents-42')
    expect(tool[0].tool_name).toBe('Read')

    // Events: tool_use (assistant) pairs with the result (user) by toolUseId.
    const use = events.find(e => e.type === 'assistant' && e.tool === 'Read')!
    expect(use.toolUseId).toBe('call-1')
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'call-1')!
    expect(result.toolResult).toBe('file-contents-42')
    expect(result.toolResultIsError).toBe(false)
    // Final text arrived as an assistant text event.
    expect(events.some(e => e.type === 'assistant' && e.text === 'all done')).toBe(true)
  })

  it('executes parallel tool_calls from one message in order', async () => {
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'AAA', 'utf8')
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'BBB', 'utf8')
    const transport = makeFakeTransport([
      {
        chunks: [
          toolCallChunk('Read', { file_path: 'a.txt' }, 'c-a'),
          toolCallChunk('Read', { file_path: 'b.txt' }, 'c-b'),
          usageChunk(10, 2),
        ],
      },
      { chunks: [textChunk('done'), usageChunk(20, 2)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const tool = toolMessages(transport, 1)
    expect(tool.map(m => m.content)).toEqual(['AAA', 'BBB'])
    const results = events.filter(e => e.type === 'user' && e.toolUseId != null)
    expect(results.map(e => e.toolUseId)).toEqual(['c-a', 'c-b'])
  })

  it('a text-only response ends the run with exit 0 and no further requests', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('nothing to do'), usageChunk(5, 1)] }])
    const { handle } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect(transport.requests).toHaveLength(1)
  })

  it('stops at the iteration cap with a system event and exit 1', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'x', 'utf8')
    const turn = () => ({ chunks: [toolCallChunk('Read', { file_path: 'f.txt' }), usageChunk(1, 1)] })
    const transport = makeFakeTransport([turn(), turn(), turn(), turn()])
    const { handle, events } = startSession(transport, { maxIterations: 3 })
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(transport.requests).toHaveLength(3)
    expect(events.some(e => e.type === 'system' && /iteration cap \(3\) reached/.test(e.text ?? ''))).toBe(true)
  })

  it('feeds malformed arguments back as an error result without executing', async () => {
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('Read', '{not-json', 'bad-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('recovered'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'bad-1')!
    expect(result.toolResultIsError).toBe(true)
    expect(String(result.toolResult)).toMatch(/not a valid JSON object/)
    // The model saw the rejection as a tool message and could self-correct.
    expect(toolMessages(transport, 1)[0].content).toMatch(/not a valid JSON object/)
  })

  it('rejects an unknown tool without executing, listing what is available', async () => {
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('Hammer', { nail: 1 }, 'unk-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'unk-1')!
    expect(result.toolResultIsError).toBe(true)
    expect(String(result.toolResult)).toMatch(/"Hammer" is not available/)
    expect(String(result.toolResult)).toMatch(/Available tools:.*Read/)
  })

  it('never advertises or dispatches an ungranted MCP tool', async () => {
    const mcp = makeFakeMcpClient('vault', [{ name: 'secret_op', inputSchema: { type: 'object' } }])
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('mcp__vault__secret_op', {}, 'v-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport, {
      // vault is resolved/mounted but the allowlist does NOT grant mcp__vault.
      assets: fakeAssets({
        allowedTools: ['Read'],
        mcpServers: [{ name: 'vault', sourceKind: 'k', config: { command: 'x', args: [], env: {} }, estTokens: null }],
      }),
    }, { connectMcp: async () => mcp })
    expect(await handle.done).toEqual({ exitCode: 0 })
    // Not advertised…
    const advertised = (transport.requests[0].tools ?? []).map(t => t.function.name)
    expect(advertised).not.toContain('mcp__vault__secret_op')
    // …and the dispatch was rejected without reaching the server.
    expect(mcp.calls).toHaveLength(0)
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'v-1')!
    expect(result.toolResultIsError).toBe(true)
  })

  it('advertises and dispatches a granted MCP tool with the 60s per-call budget', async () => {
    const mcp = makeFakeMcpClient('kstore', [
      { name: 'lesson_list', description: 'List lessons', inputSchema: { type: 'object', properties: {} } },
    ])
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('mcp__kstore__lesson_list', { limit: 5 }, 'k-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__kstore'],
        mcpServers: [{ name: 'kstore', sourceKind: 'k', config: { command: 'x', args: [], env: {} }, estTokens: null }],
      }),
    }, { connectMcp: async () => mcp })
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect((transport.requests[0].tools ?? []).map(t => t.function.name)).toContain('mcp__kstore__lesson_list')
    expect(mcp.calls).toEqual([{ tool: 'lesson_list', args: { limit: 5 }, timeoutMs: 60_000 }])
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'k-1')!
    expect(result.toolResult).toBe('lesson_list ok')
    expect(mcp.closed).toBe(true) // closed in the loop's finally
  })

  it('truncates the tool MESSAGE at 8k chars but keeps the full result on the event', async () => {
    fs.writeFileSync(path.join(worktree, 'big.txt'), 'z'.repeat(12_000), 'utf8')
    const transport = makeFakeTransport([
      { chunks: [toolCallChunk('Read', { file_path: 'big.txt' }, 'big-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const msg = toolMessages(transport, 1)[0].content
    expect(msg.length).toBeLessThan(TOOL_RESULT_MESSAGE_CAP_CHARS + 100)
    expect(msg).toMatch(/output truncated at 8000 chars/)
    const event = events.find(e => e.type === 'user' && e.toolUseId === 'big-1')!
    expect(String(event.toolResult).length).toBe(12_000)
  })

  it('aborts the run at runTimeoutMs with an error event', async () => {
    const transport = makeFakeTransport([{ hang: true }])
    const { handle, events } = startSession(transport, { runTimeoutMs: 150 })
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(events.some(e => e.type === 'error' && /timed out after 150ms/.test(e.text ?? ''))).toBe(true)
  })

  it('degrades (system event, run continues) when an MCP server fails to start', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('fine without it'), usageChunk(1, 1)] }])
    const { handle, events } = startSession(transport, {
      assets: fakeAssets({
        allowedTools: ['Read', 'mcp__broken'],
        mcpServers: [{ name: 'broken', sourceKind: 'k', config: { command: 'x', args: [], env: {} }, estTokens: null }],
      }),
    }, { connectMcp: async () => { throw new Error('spawn ENOENT') } })
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect(events.some(e =>
      e.type === 'system' && /MCP server broken failed to start — tools unavailable/.test(e.text ?? ''),
    )).toBe(true)
  })

  it('injects a warning after 3 identical consecutive calls', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'x', 'utf8')
    const same = () => ({ chunks: [toolCallChunk('Read', { file_path: 'f.txt' }), usageChunk(1, 1)] })
    const transport = makeFakeTransport([
      same(), same(), same(),
      { chunks: [textChunk('breaking the loop'), usageChunk(1, 1)] },
    ])
    const { handle } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    // The 4th request (after 3 identical rounds) carries the injected warning.
    const warning = transport.requests[3].messages.filter(
      m => m.role === 'user' && /identical arguments 3 times/.test(m.content),
    )
    expect(warning).toHaveLength(1)
    // …and the earlier requests do not.
    expect(transport.requests[2].messages.some(m => /identical arguments/.test(m.content))).toBe(false)
  })

  it('parses STRING-encoded arguments once — event toolInput and dispatch both see the object', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'string-args-content', 'utf8')
    const transport = makeFakeTransport([
      // Protocol drift: some daemons stringify arguments.
      { chunks: [toolCallChunk('Read', '{"file_path":"f.txt"}', 'str-1'), usageChunk(1, 1)] },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const use = events.find(e => e.type === 'assistant' && e.toolUseId === 'str-1')!
    expect(use.toolInput).toEqual({ file_path: 'f.txt' }) // parsed object, not the raw string
    const result = events.find(e => e.type === 'user' && e.toolUseId === 'str-1')!
    expect(result.toolResult).toBe('string-args-content') // dispatch executed with the same object
  })

  it('deduplicates tool_calls repeated across chunks by id (cumulative-array drift)', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'once', 'utf8')
    const transport = makeFakeTransport([
      {
        chunks: [
          toolCallChunk('Read', { file_path: 'f.txt' }, 'dup-1'),
          // The same call repeated on a later chunk (a cumulative-array daemon).
          toolCallChunk('Read', { file_path: 'f.txt' }, 'dup-1'),
          usageChunk(1, 1),
        ],
      },
      { chunks: [textChunk('ok'), usageChunk(1, 1)] },
    ])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect(events.filter(e => e.type === 'user' && e.toolUseId === 'dup-1')).toHaveLength(1)
    expect(toolMessages(transport, 1)).toHaveLength(1) // executed once, one result message
  })

  it('trips the repeat detector on an identical PARALLEL call set', async () => {
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'a', 'utf8')
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'b', 'utf8')
    const pair = () => ({
      chunks: [
        toolCallChunk('Read', { file_path: 'a.txt' }),
        toolCallChunk('Read', { file_path: 'b.txt' }),
        usageChunk(1, 1),
      ],
    })
    const transport = makeFakeTransport([
      pair(), pair(), pair(),
      { chunks: [textChunk('done'), usageChunk(1, 1)] },
    ])
    const { handle } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const warning = transport.requests[3].messages.filter(
      m => m.role === 'user' && /identical arguments 3 times/.test(m.content),
    )
    expect(warning).toHaveLength(1)
  })

  it('emits the run-start system event with truthful counts', async () => {
    const transport = makeFakeTransport([{ chunks: [textChunk('hi'), usageChunk(1, 1)] }])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 0 })
    const start = events.find(e => e.type === 'system' && (e.text ?? '').startsWith('ollama-agent:'))!
    expect(start.text).toBe('ollama-agent: model=llama3.2, tools=6 (native 6, mcp 0), skills=0, toolSupport=true')
  })

  it('surfaces a transport failure as an error event with exit 1 (done never rejects)', async () => {
    const transport = makeFakeTransport([{ error: new Error('Ollama /api/chat responded 500') }])
    const { handle, events } = startSession(transport)
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(events.some(e => e.type === 'error' && /responded 500/.test(e.text ?? ''))).toBe(true)
  })
})
