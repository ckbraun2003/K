/**
 * Ollama agent events (Lane B, wave B2) — every emitted event must be
 * indistinguishable, shape-wise, from the claude path's parseClaudeLine
 * output: AgentEventSchema-valid, pairToolCalls-compatible, and correctly
 * consumed by the supervisor's accumulate().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { AgentEventSchema, type AgentEvent } from '@k/shared'
import { accumulate } from '../src/supervisor.js'
import { classifyTool } from '../src/providers.js'
import {
  assistantTextEvent,
  assistantToolUseEvent,
  systemEvent,
  usageEvent,
  userToolResultEvent,
} from '../src/ollama-agent/events.js'
import { startOllamaAgentRun } from '../src/ollama-agent/loop.js'
import {
  fakeAssets,
  makeFakeTransport,
  textChunk,
  toolCallChunk,
  usageChunk,
} from './helpers/ollama-fakes.js'

// pairToolCalls is a WEB lib (web/src/lib/console.ts) — mirroring its pairing
// contract here keeps core's gate self-contained: an assistant event carrying
// toolUseId must pair with the user event carrying the same toolUseId.
function pairLikeConsole(events: AgentEvent[]): Array<{ call: AgentEvent; result?: AgentEvent }> {
  const resultByToolUseId = new Map<string, AgentEvent>()
  for (const e of events) {
    if (e.type === 'user' && e.toolUseId != null && !resultByToolUseId.has(e.toolUseId)) {
      resultByToolUseId.set(e.toolUseId, e)
    }
  }
  const items: Array<{ call: AgentEvent; result?: AgentEvent }> = []
  for (const e of events) {
    if (e.type === 'assistant' && e.toolUseId != null) {
      items.push({ call: e, result: resultByToolUseId.get(e.toolUseId) })
    }
  }
  return items
}

let worktree: string

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-events-'))
})

afterEach(() => {
  try { fs.rmSync(worktree, { recursive: true, force: true }) } catch { /* win lock */ }
})

async function runScriptedSession() {
  fs.writeFileSync(path.join(worktree, 'f.txt'), 'payload', 'utf8')
  const transport = makeFakeTransport([
    { chunks: [textChunk('thinking…'), toolCallChunk('Read', { file_path: 'f.txt' }, 'pair-1'), usageChunk(120, 30)] },
    { chunks: [textChunk('final answer'), usageChunk(200, 12)] },
  ])
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
    },
    { transport },
  )
  const result = await handle.done
  return { events, result }
}

describe('event validity', () => {
  it('every emitted event passes AgentEventSchema with monotonic seq from 0', async () => {
    const { events, result } = await runScriptedSession()
    expect(result.exitCode).toBe(0)
    expect(events.length).toBeGreaterThanOrEqual(6) // system, text, tool_use, usage, result, text, usage
    for (const e of events) {
      const parsed = AgentEventSchema.safeParse(e)
      expect(parsed.success, `event ${e.type} seq ${e.seq} must validate: ${JSON.stringify(e)}`).toBe(true)
    }
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i))
  })

  it('tool_use/tool_result events pair exactly like the run console pairs claude events', async () => {
    const { events } = await runScriptedSession()
    const items = pairLikeConsole(events)
    expect(items).toHaveLength(1)
    expect(items[0].call.tool).toBe('Read')
    expect(items[0].call.toolKind).toBe('other') // classifyTool('Read') — same as claude
    expect(items[0].call.toolInput).toEqual({ file_path: 'f.txt' })
    expect(items[0].result).toBeDefined()
    expect(items[0].result!.toolResult).toBe('payload')
    expect(items[0].result!.toolResultIsError).toBe(false)
  })

  it('usage events sum through supervisor.accumulate with an authoritative $0 cost', async () => {
    const { events } = await runScriptedSession()
    const totals = events.reduce(
      (acc, e) => accumulate(acc, e),
      { tokensIn: 0, tokensOut: 0, costUsd: 99.99 }, // stale non-zero must be overwritten
    )
    expect(totals.tokensIn).toBe(320) // 120 + 200
    expect(totals.tokensOut).toBe(42) // 30 + 12
    expect(totals.costUsd).toBe(0) // real 0 wins (free local run)
  })

  it('usage events carry contextTokens = prompt_eval + eval', async () => {
    const { events } = await runScriptedSession()
    const usages = events.filter(e => e.type === 'usage')
    expect(usages).toHaveLength(2)
    expect(usages[0].tokensIn).toBe(120)
    expect(usages[0].tokensOut).toBe(30)
    expect(usages[0].contextTokens).toBe(150)
    expect(usages.every(e => e.costUsd === 0)).toBe(true)
  })

  it('emits the run-start system declaration before any assistant event', async () => {
    const { events } = await runScriptedSession()
    const firstAssistant = events.findIndex(e => e.type === 'assistant')
    const runStart = events.findIndex(e => e.type === 'system' && (e.text ?? '').startsWith('ollama-agent:'))
    expect(runStart).toBeGreaterThanOrEqual(0)
    expect(runStart).toBeLessThan(firstAssistant)
    expect(events[runStart].text).toMatch(/^ollama-agent: model=.+, tools=\d+ \(native \d+, mcp \d+\), skills=\d+, toolSupport=(true|false)$/)
  })
})

describe('event constructors (pure)', () => {
  const base = { runId: uuid(), seq: 7 }

  it('constructors produce schema-valid events with claude-compatible fields', () => {
    const candidates: AgentEvent[] = [
      systemEvent(base, 'note'),
      assistantTextEvent(base, 'prose'),
      assistantToolUseEvent(base, { tool: 'Bash', toolUseId: 't-1', toolInput: { command: 'ls' } }),
      userToolResultEvent(base, { toolUseId: 't-1', toolResult: 'out', isError: false }),
      usageEvent(base, { promptEvalCount: 10, evalCount: 3 }),
    ]
    for (const e of candidates) {
      expect(AgentEventSchema.safeParse(e).success, `${e.type} must validate`).toBe(true)
      expect(e.seq).toBe(7)
    }
  })

  it('assistantToolUseEvent classifies with the SAME table as the claude parser', () => {
    for (const [tool, kind] of [
      ['Bash', 'command'],
      ['Write', 'file'],
      ['Edit', 'file'],
      ['Read', 'other'],
      ['mcp__kstore__lesson_list', 'other'],
      ['read_skill', 'other'],
    ] as const) {
      const e = assistantToolUseEvent(base, { tool, toolUseId: 'x' })
      expect(e.toolKind).toBe(kind)
      expect(e.toolKind).toBe(classifyTool(tool))
    }
  })

  it('usageEvent defaults missing counters to 0 and omits contextTokens when empty', () => {
    const empty = usageEvent(base, {})
    expect(empty.tokensIn).toBe(0)
    expect(empty.tokensOut).toBe(0)
    expect(empty.costUsd).toBe(0)
    expect(empty.contextTokens).toBeUndefined()
    const half = usageEvent(base, { evalCount: 5 })
    expect(half.contextTokens).toBe(5)
  })
})
