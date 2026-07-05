/**
 * Capability policy (Lane B, wave B4) — the truthful tools-vs-prompt-only
 * decision for local models:
 *   - /api/show 'tools' membership is the verdict (cached per model);
 *   - capabilities missing (old daemon) → optimistic try-once, DOWNGRADED and
 *     cached when the daemon rejects with the does-not-support-tools 400;
 *   - a no-tools model degrades IN PLACE (prompt-only, skills inlined within
 *     the char budget) — never a silent claude fallback;
 *   - pull invalidates the cached verdict (routes/ollama.ts);
 *   - context-pressure warning once per run at >85% of the shown window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import {
  resolveModelCapability,
  markModelToolUnsupported,
  invalidateModelCapability,
  isToolUnsupportedError,
  __resetModelCapabilityCache,
} from '../src/ollama-agent/capability.js'
import { OllamaTransportError, type OllamaChatTransport } from '../src/ollama-agent/transport.js'
import { buildInlineSkillsSection } from '../src/ollama-agent/native-tools.js'
import { startOllamaAgentRun } from '../src/ollama-agent/loop.js'
import type { ResolvedSkill } from '../src/run-assets.js'
import {
  fakeAssets,
  makeFakeTransport,
  textChunk,
  toolCallChunk,
  usageChunk,
  type FakeTransport,
} from './helpers/ollama-fakes.js'

let worktree: string
const tmpDirs: string[] = []

beforeEach(() => {
  __resetModelCapabilityCache()
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-cap-'))
  tmpDirs.push(worktree)
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* win lock */ }
  }
})

/** A transport whose show() is scripted and counted. */
function showTransport(
  result: { capabilities: string[]; contextLength?: number } | 'unreachable',
): OllamaChatTransport & { showCalls: number } {
  const t = {
    showCalls: 0,
    chat(): AsyncIterable<never> {
      throw new Error('chat not scripted')
    },
    async show() {
      t.showCalls++
      if (result === 'unreachable') throw new OllamaTransportError('Ollama /api/show failed: ECONNREFUSED')
      return result
    },
  }
  return t
}

function skillFixture(name: string, body: string): ResolvedSkill {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), `k-cap-skill-${name}-`))
  tmpDirs.push(srcDir)
  fs.writeFileSync(path.join(srcDir, 'SKILL.md'), body, 'utf8')
  return { qualifiedKey: name, name, mountDirName: name, sourceKind: 'k', srcDir, estTokens: Math.ceil(body.length / 4) }
}

function startSession(transport: FakeTransport, cfg: Record<string, unknown> = {}) {
  const events: AgentEvent[] = []
  let seq = 0
  const handle = startOllamaAgentRun(
    {
      runId: uuid(),
      model: (cfg.model as string) ?? 'cap-model',
      prompt: 'p',
      cwd: worktree,
      assets: fakeAssets(),
      nextSeq: () => seq++,
      onEvent: e => events.push(e),
      fsScope: 'worktree',
      ...cfg,
    },
    { transport },
  )
  return { handle, events }
}

// ─── resolveModelCapability ───────────────────────────────────────────────────

describe('resolveModelCapability', () => {
  it('reads the tools verdict from show capabilities and caches per model', async () => {
    const yes = showTransport({ capabilities: ['completion', 'tools'], contextLength: 4096 })
    const cap1 = await resolveModelCapability('m-tools', yes)
    expect(cap1).toEqual({ toolSupport: true, contextLength: 4096, source: 'show-capabilities' })
    await resolveModelCapability('m-tools', yes)
    expect(yes.showCalls).toBe(1) // cached — one probe per process lifetime

    const no = showTransport({ capabilities: ['completion'] })
    const cap2 = await resolveModelCapability('m-plain', no)
    expect(cap2.toolSupport).toBe(false)
    expect(cap2.source).toBe('show-capabilities')
  })

  it('is optimistic when capabilities are missing (old daemon) — cached for downgrade', async () => {
    const old = showTransport({ capabilities: [], contextLength: 2048 })
    const cap = await resolveModelCapability('m-old', old)
    expect(cap).toEqual({ toolSupport: true, contextLength: 2048, source: 'show-missing' })
    markModelToolUnsupported('m-old')
    const after = await resolveModelCapability('m-old', old)
    expect(after.toolSupport).toBe(false)
    expect(after.contextLength).toBe(2048) // preserved through the downgrade
    expect(old.showCalls).toBe(1) // downgrade did not re-probe
  })

  it('attempts tools but does NOT cache when show is unreachable (transient)', async () => {
    const down = showTransport('unreachable')
    const cap = await resolveModelCapability('m-down', down)
    expect(cap).toEqual({ toolSupport: true, source: 'show-unreachable' })
    await resolveModelCapability('m-down', down)
    expect(down.showCalls).toBe(2) // re-probed — never cached
  })

  it('invalidateModelCapability clears the verdict, covering the :latest alias', async () => {
    const t = showTransport({ capabilities: ['tools'] })
    await resolveModelCapability('m-x', t)
    invalidateModelCapability('m-x:latest') // pull name with the explicit tag
    await resolveModelCapability('m-x', t)
    expect(t.showCalls).toBe(2) // re-probed after invalidation

    await resolveModelCapability('m-y:latest', t)
    invalidateModelCapability('m-y') // pull name without the tag
    await resolveModelCapability('m-y:latest', t)
    expect(t.showCalls).toBe(4)
  })
})

describe('isToolUnsupportedError', () => {
  it('matches only the 400 does-not-support-tools rejection', () => {
    expect(isToolUnsupportedError(
      new OllamaTransportError('Ollama /api/chat responded 400', 400, '{"error":"registry.ollama.ai/library/x does not support tools"}'),
    )).toBe(true)
    expect(isToolUnsupportedError(
      new OllamaTransportError('Ollama chat error: model does not support tools', 400),
    )).toBe(true)
    expect(isToolUnsupportedError(new OllamaTransportError('Ollama /api/chat responded 400', 400, 'bad request'))).toBe(false)
    expect(isToolUnsupportedError(new OllamaTransportError('Ollama /api/chat responded 500', 500, 'does not support tools'))).toBe(false)
    expect(isToolUnsupportedError(new Error('does not support tools'))).toBe(false)
  })
})

// ─── inline skills (degrade path) ─────────────────────────────────────────────

describe('buildInlineSkillsSection', () => {
  it('inlines every body within budget and returns null with no skills', () => {
    const a = skillFixture('alpha', '---\nname: alpha\ndescription: a\n---\nAlpha body.')
    const b = skillFixture('beta', '---\nname: beta\ndescription: b\n---\nBeta body.')
    const section = buildInlineSkillsSection([a, b])!
    expect(section).toContain('### Skill: alpha')
    expect(section).toContain('Alpha body.')
    expect(section).toContain('### Skill: beta')
    expect(section).not.toContain('Skipped for context budget')
    expect(buildInlineSkillsSection([])).toBeNull()
  })

  it('skips the LARGEST bodies when over budget, naming them in a note', () => {
    const small = skillFixture('small', 's'.repeat(100))
    const large = skillFixture('large', 'L'.repeat(500))
    const section = buildInlineSkillsSection([small, large], 200)!
    expect(section).toContain('### Skill: small')
    expect(section).not.toContain('LLLL')
    expect(section).toMatch(/Skipped for context budget: large/)
  })

  it('degenerate budgets (0 / negative) inline nothing but still name every skill as skipped', () => {
    const a = skillFixture('aaa', 'body-a')
    const b = skillFixture('bbb', 'body-b')
    for (const budget of [0, -100]) {
      const section = buildInlineSkillsSection([a, b], budget)!
      expect(section).not.toContain('body-a')
      expect(section).not.toContain('body-b')
      expect(section).toMatch(/Skipped for context budget: .*aaa/)
      expect(section).toMatch(/bbb/)
    }
  })
})

// ─── loop integration: degrade in place ───────────────────────────────────────

describe('degrade-in-place (loop + capability)', () => {
  it('a no-tools model runs prompt-only with skills inlined and a truthful run-start event', async () => {
    const skill = skillFixture('guide', '---\nname: guide\ndescription: g\n---\nInlined guide body.')
    const transport = makeFakeTransport(
      [{ chunks: [textChunk('prompt-only answer'), usageChunk(50, 9)] }],
      { capabilities: ['completion'], contextLength: 2048 }, // NO 'tools'
    )
    const { handle, events } = startSession(transport, {
      model: 'no-tools-model',
      assets: fakeAssets({ skills: [skill] }),
    })
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect(transport.showCalls).toEqual(['no-tools-model'])
    // Single prompt-only chat call: no tools advertised…
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0].tools).toBeUndefined()
    // …skills inlined into the system prompt (read_skill does not exist here)…
    const system = transport.requests[0].messages[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('Inlined guide body.')
    expect(system.content).toContain('## Skills (inlined')
    // …and the run-start declaration is truthful (drives the console badge).
    const start = events.find(e => e.type === 'system' && (e.text ?? '').startsWith('ollama-agent:'))!
    expect(start.text).toContain('toolSupport=false')
    expect(start.text).toContain('tools=0')
  })

  it('an old daemon (no capabilities) tries tools once, degrades on the 400, and caches the verdict', async () => {
    const transport = makeFakeTransport(
      [
        { error: new OllamaTransportError('Ollama /api/chat responded 400', 400, '"old-model" does not support tools') },
        { chunks: [textChunk('recovered prompt-only'), usageChunk(10, 3)] },
      ],
      { capabilities: [] }, // old daemon: no capabilities field
    )
    const { handle, events } = startSession(transport, { model: 'old-model' })
    expect(await handle.done).toEqual({ exitCode: 0 })
    // First request attempted tools (optimistic), the retry did not.
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0].tools?.length).toBeGreaterThan(0)
    expect(transport.requests[1].tools).toBeUndefined()
    // The degrade was declared…
    expect(events.some(e =>
      e.type === 'system' && /rejected tools \(400\) — degraded to prompt-only/.test(e.text ?? ''),
    )).toBe(true)
    // …and CACHED: the next capability resolve is false without another probe.
    const probe = showTransport({ capabilities: [] })
    expect((await resolveModelCapability('old-model', probe)).toolSupport).toBe(false)
    expect(probe.showCalls).toBe(0)
  })

  it('a genuine 400 (not tools-related) stays a run error — no silent degrade', async () => {
    const transport = makeFakeTransport(
      [{ error: new OllamaTransportError('Ollama /api/chat responded 400', 400, 'invalid options') }],
      { capabilities: ['tools'] },
    )
    const { handle, events } = startSession(transport, { model: 'bad-req-model' })
    expect(await handle.done).toEqual({ exitCode: 1 })
    expect(events.some(e => e.type === 'error' && /responded 400/.test(e.text ?? ''))).toBe(true)
    expect(transport.requests).toHaveLength(1) // no retry
  })
})

// ─── context pressure ─────────────────────────────────────────────────────────

describe('context-pressure warning', () => {
  it('warns ONCE when prompt_eval_count exceeds 85% of the shown context length', async () => {
    fs.writeFileSync(path.join(worktree, 'f.txt'), 'x', 'utf8')
    const transport = makeFakeTransport(
      [
        { chunks: [toolCallChunk('Read', { file_path: 'f.txt' }), usageChunk(900, 10)] }, // 900 > 0.85 * 1000
        { chunks: [toolCallChunk('Read', { file_path: 'f.txt' }), usageChunk(950, 10)] }, // still over — no second warning
        { chunks: [textChunk('done'), usageChunk(980, 5)] },
      ],
      { capabilities: ['completion', 'tools'], contextLength: 1000 },
    )
    const { handle, events } = startSession(transport, { model: 'small-ctx-model' })
    expect(await handle.done).toEqual({ exitCode: 0 })
    const warnings = events.filter(e => e.type === 'system' && /context pressure/.test(e.text ?? ''))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].text).toContain('900')
    expect(warnings[0].text).toContain('1000')
  })

  it('never warns when the window is comfortable', async () => {
    const transport = makeFakeTransport(
      [{ chunks: [textChunk('fine'), usageChunk(100, 5)] }],
      { capabilities: ['tools'], contextLength: 8192 },
    )
    const { handle, events } = startSession(transport, { model: 'roomy-model' })
    expect(await handle.done).toEqual({ exitCode: 0 })
    expect(events.some(e => /context pressure/.test(e.text ?? ''))).toBe(false)
  })
})
