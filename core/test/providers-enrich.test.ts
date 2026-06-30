/**
 * Wave D3 — enriched tool metadata in parseClaudeLine.
 *
 * Fixtures below are REAL captured stream-json shapes. The parser stays PURE and
 * table-driven; tool_use (assistant) ↔ tool_result (user) pair by toolUseId.
 * Token/cost accumulation (the `result` branch) must be byte-for-byte unchanged.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { v4 as uuid } from 'uuid'
import { parseClaudeLine, classifyTool } from '../src/providers.js'
import { eventBus } from '../src/events.js'
import { runsDb, eventsDb, db } from '../src/db.js'

const RUN_ID = '00000000-0000-0000-0000-000000000000'

describe('classifyTool — table-driven mapper', () => {
  it('maps Bash → command', () => expect(classifyTool('Bash')).toBe('command'))
  it('maps the edit family → file', () => {
    expect(classifyTool('Write')).toBe('file')
    expect(classifyTool('Edit')).toBe('file')
    expect(classifyTool('MultiEdit')).toBe('file')
    expect(classifyTool('NotebookEdit')).toBe('file')
  })
  it('maps Task → delegate', () => expect(classifyTool('Task')).toBe('delegate'))
  it('maps Agent → delegate (this environment names delegation Agent)', () => expect(classifyTool('Agent')).toBe('delegate'))
  it('maps an unknown tool → other', () => expect(classifyTool('Glob')).toBe('other'))
})

describe('parseClaudeLine — tool_use enrichment (assistant)', () => {
  it('Bash → toolKind command, toolUseId, toolInput.command', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_a","name":"Bash","input":{"command":"echo smoke-test","description":"Run echo"}}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.tool).toBe('Bash')
    expect(ev.toolKind).toBe('command')
    expect(ev.toolUseId).toBe('toolu_a')
    expect((ev.toolInput as { command: string }).command).toBe('echo smoke-test')
    expect(ev.subagentType).toBeUndefined()
    expect(ev.childLabel).toBeUndefined()
  })

  it('Write → toolKind file, toolInput.file_path', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_b","name":"Write","input":{"file_path":"/tmp/x.ts","content":"hi"}}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.toolKind).toBe('file')
    expect((ev.toolInput as { file_path: string }).file_path).toBe('/tmp/x.ts')
  })

  it('Agent WITHOUT subagent_type → delegate, subagentType undefined, childLabel from description', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_c","name":"Agent","input":{"description":"Reply done","prompt":"reply with done"}}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.toolKind).toBe('delegate')
    expect(ev.subagentType).toBeUndefined()
    expect(ev.childLabel).toBe('Reply done')
  })

  it('Task WITH subagent_type → delegate, subagentType set', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_d","name":"Task","input":{"description":"Do research","prompt":"go","subagent_type":"Explore"}}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.toolKind).toBe('delegate')
    expect(ev.subagentType).toBe('Explore')
    expect(ev.childLabel).toBe('Do research')
  })

  it('delegate without description falls back to first ~60 chars of prompt', () => {
    const prompt = 'x'.repeat(100)
    const line = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_e","name":"Agent","input":{"prompt":"${prompt}"}}]}}`
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.childLabel).toBe('x'.repeat(60))
  })
})

describe('parseClaudeLine — tool_result enrichment (user)', () => {
  it('STRING content pairs by tool_use_id, no is_error', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"smoke-test\\n"}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 2)!
    expect(ev.type).toBe('user')
    expect(ev.toolUseId).toBe('toolu_a')
    expect(ev.toolResult).toBe('smoke-test\n')
    expect(ev.toolResultIsError).toBeUndefined()
    expect(ev.text).toBeUndefined()
  })

  it('ARRAY content + is_error:false → toolResult is the array, toolResultIsError false', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_c","content":[{"type":"text","text":"done"}],"is_error":false}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 2)!
    expect(ev.toolUseId).toBe('toolu_c')
    expect(Array.isArray(ev.toolResult)).toBe(true)
    expect((ev.toolResult as Array<{ text: string }>)[0].text).toBe('done')
    expect(ev.toolResultIsError).toBe(false)
  })

  it('is_error:true → toolResultIsError true', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"boom","is_error":true}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 2)!
    expect(ev.toolResultIsError).toBe(true)
  })
})

describe('parseClaudeLine — backward compatibility', () => {
  it('a plain assistant text line sets text and leaves all tool fields undefined', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"yo"}]}}'
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.text).toBe('yo')
    expect(ev.tool).toBeUndefined()
    expect(ev.toolUseId).toBeUndefined()
    expect(ev.toolKind).toBeUndefined()
    expect(ev.toolInput).toBeUndefined()
  })

  it('the result branch still accumulates tokens + cost unchanged', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 },
      total_cost_usd: 0.012,
      result: 'final answer',
    })
    const ev = parseClaudeLine(line, RUN_ID, 9)!
    expect(ev.type).toBe('usage')
    expect(ev.tokensIn).toBe(115)
    expect(ev.tokensOut).toBe(50)
    expect(ev.costUsd).toBe(0.012)
    expect(ev.text).toBe('final answer')
  })
})

describe('parseClaudeLine — contextTokens (input context size for the indicator)', () => {
  it('assistant: contextTokens = input + cache_creation + cache_read; tokensIn stays fresh input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 20 },
      },
    })
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.type).toBe('assistant')
    expect(ev.contextTokens).toBe(6100)
    expect(ev.tokensIn).toBe(100) // fresh input only — cost/metrics unchanged
    expect(ev.tokensOut).toBe(20)
  })

  it('assistant: omits contextTokens when no usage is present', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.contextTokens).toBeUndefined()
  })

  it('assistant: tolerates missing cache fields (contextTokens = input_tokens)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 42, output_tokens: 7 } },
    })
    const ev = parseClaudeLine(line, RUN_ID, 1)!
    expect(ev.contextTokens).toBe(42)
    expect(ev.tokensIn).toBe(42)
  })

  it('result: contextTokens equals the full input sum (matches tokensIn)', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 },
      total_cost_usd: 0.012,
      result: 'done',
    })
    const ev = parseClaudeLine(line, RUN_ID, 9)!
    expect(ev.type).toBe('usage')
    expect(ev.contextTokens).toBe(115)
    expect(ev.tokensIn).toBe(115)
  })
})

describe('persistence round-trip — enriched fields survive emit → list', () => {
  const RID = uuid()
  runsDb.insertRun.run({
    id: RID, prompt: 'enrich rt', cwd: '/tmp', worktree: null, status: 'done',
    provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 0, tokensOut: 0,
    costUsd: 0, projectId: null, createdAt: Date.now(),
  })

  afterAll(() => {
    db.prepare('DELETE FROM events WHERE run_id = ?').run(RID)
    db.prepare('DELETE FROM runs WHERE id = ?').run(RID)
  })

  it('a delegate tool_use round-trips with JSON-parsed input', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_rt","name":"Task","input":{"description":"RT","prompt":"go","subagent_type":"Explore"}}]}}'
    const ev = parseClaudeLine(line, RID, 1)!
    eventBus.emitEvent(ev)

    const rows = eventsDb.listEvents.all(RID) as Array<Record<string, unknown>>
    const row = rows.find(r => r.seq === 1)!
    expect(row.tool).toBe('Task')
    expect(row.tool_kind).toBe('delegate')
    expect(row.tool_use_id).toBe('toolu_rt')
    expect(row.subagent_type).toBe('Explore')
    expect(row.child_label).toBe('RT')
    expect(JSON.parse(row.tool_input as string)).toMatchObject({ description: 'RT', subagent_type: 'Explore' })
  })

  it('a tool_result with array content + is_error round-trips', () => {
    const line = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_rt","content":[{"type":"text","text":"done"}],"is_error":false}]}}'
    const ev = parseClaudeLine(line, RID, 2)!
    eventBus.emitEvent(ev)

    const rows = eventsDb.listEvents.all(RID) as Array<Record<string, unknown>>
    const row = rows.find(r => r.seq === 2)!
    expect(row.tool_use_id).toBe('toolu_rt')
    expect(row.tool_result_is_error).toBe(0)
    expect(JSON.parse(row.tool_result as string)).toEqual([{ type: 'text', text: 'done' }])
  })

  it('contextTokens persists to the context_tokens column (Wave D6)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 20 },
      },
    })
    const ev = parseClaudeLine(line, RID, 3)!
    expect(ev.contextTokens).toBe(6100)
    eventBus.emitEvent(ev)

    const rows = eventsDb.listEvents.all(RID) as Array<Record<string, unknown>>
    const row = rows.find(r => r.seq === 3)!
    expect(row.context_tokens).toBe(6100) // full input sum persisted
    expect(row.tokens_in).toBe(100)       // fresh-input accounting unchanged
  })
})
