/**
 * Supervisor ↔ Ollama agent loop integration (Lane B, wave B3).
 *
 * Drives the REAL startRun → runAgent path with the route forced to ollama
 * (config enabled + reachability probe against a stubbed fetch) and the agent
 * loop's transport overridden via __testHooks.setOllamaTransport — no live
 * daemon, no module mocks. Locks:
 *   - queued → running → done status flow with the run-start system event;
 *   - per-iteration usage persisted on the run row (tokens, $0 cost);
 *   - kill() → 'killed' (and endSession() reaching a non-interactive ollama
 *     run through the same path);
 *   - worktree cleanup on terminal;
 *   - the ollama.numCtx config key threaded into options.num_ctx.
 * (K_OLLAMA_AGENT_MODE=legacy lives in ollama-legacy-mode.test.ts with execa
 * mocked.) The claude path's regression lock is the EXISTING supervisor suites
 * passing unmodified — nothing here touches them.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { db } from '../src/db.js'
import { startRun, kill, endSession, __testHooks, ollamaAgentModeEnabled } from '../src/supervisor.js'
import { probeOllama } from '../src/router.js'
import {
  setOllamaEnabled,
  setActiveOllamaModel,
  ollamaNumCtx,
  setOllamaNumCtx,
  DEFAULT_OLLAMA_NUM_CTX,
  __resetConfigCache,
} from '../src/config-store.js'
import { DEFAULT_NUM_CTX } from '../src/ollama-agent/loop.js'
import {
  makeFakeMcpClient,
  makeFakeTransport,
  textChunk,
  usageChunk,
  type FakeTransport,
} from './helpers/ollama-fakes.js'

const tmpDirs: string[] = []
const runIds: string[] = []
const ORIG_MODE = process.env.K_OLLAMA_AGENT_MODE
const ORIG_API = process.env.ANTHROPIC_API_KEY

function freshDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `k-ollama-sup-${tag}-`))
  tmpDirs.push(d)
  return d
}

/** A minimal real git repo (worktree-creation target). */
function freshGitRepo(): string {
  const d = freshDir('repo')
  execFileSync('git', ['init', '-q'], { cwd: d })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: d })
  fs.writeFileSync(path.join(d, 'seed.txt'), 'seed', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: d })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], { cwd: d })
  return d
}

async function poll<T>(fn: () => T | undefined, timeoutMs = 15_000, everyMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise(r => setTimeout(r, everyMs))
  }
  throw new Error('poll timed out')
}

type RunRow = {
  id: string
  status: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
  worktree: string | null
}
const getRun = (id: string): RunRow | undefined =>
  db.prepare('SELECT id, status, tokens_in, tokens_out, cost_usd, worktree FROM runs WHERE id = ?').get(id) as RunRow | undefined

const runEvents = (id: string): Array<{ type: string; text: string | null }> =>
  db.prepare('SELECT type, text FROM events WHERE run_id = ? ORDER BY seq').all(id) as Array<{ type: string; text: string | null }>

const awaitTerminal = (id: string) =>
  poll(() => {
    const row = getRun(id)
    return row && ['done', 'error', 'killed', 'interrupted'].includes(row.status) ? row : undefined
  })

beforeAll(async () => {
  // Force the route to ollama: enabled in config + a reachability probe against
  // a stubbed fetch (the router refuses unproven daemons).
  setOllamaEnabled(true)
  setActiveOllamaModel('llama3.2')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response))
  expect(await probeOllama()).toBe(true)
  vi.unstubAllGlobals()
  // Managed token so a (hypothetical) claude fallback never copies host creds.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  // NEVER spawn the run-scoped MCP servers (kstore/logistics/mgmt) as REAL
  // children here — a second process opening the shared test SQLite is the
  // documented K_DATA_DIR flake source. The fake connector reports no tools.
  __testHooks.setOllamaMcpConnector(async name => makeFakeMcpClient(name, []))
})

afterEach(() => {
  __testHooks.setOllamaTransport(null)
  if (ORIG_MODE === undefined) delete process.env.K_OLLAMA_AGENT_MODE
  else process.env.K_OLLAMA_AGENT_MODE = ORIG_MODE
})

afterAll(async () => {
  __testHooks.setOllamaMcpConnector(null)
  // Flip the router back to claude-only so later suites are untouched.
  setOllamaEnabled(false)
  setActiveOllamaModel('llama3.2')
  __resetConfigCache()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
  await probeOllama()
  vi.unstubAllGlobals()
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  for (const id of runIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('ollamaAgentModeEnabled (the gate)', () => {
  it('defaults ON; only "legacy" (any case) reverts', () => {
    expect(ollamaAgentModeEnabled({})).toBe(true)
    expect(ollamaAgentModeEnabled({ K_OLLAMA_AGENT_MODE: 'legacy' })).toBe(false)
    expect(ollamaAgentModeEnabled({ K_OLLAMA_AGENT_MODE: ' LEGACY ' })).toBe(false)
    expect(ollamaAgentModeEnabled({ K_OLLAMA_AGENT_MODE: 'agent' })).toBe(true)
    expect(ollamaAgentModeEnabled({ K_OLLAMA_AGENT_MODE: '' })).toBe(true)
  })
})

describe('startRun → ollama agent loop', () => {
  it('flows queued → running → done and persists per-iteration tokens at $0', async () => {
    const transport = makeFakeTransport([
      { chunks: [textChunk('local answer'), usageChunk(100, 25)] },
    ])
    __testHooks.setOllamaTransport(transport)
    const run = await startRun('say hi', { preferLocal: true, cwd: freshDir('done') })
    runIds.push(run.id)
    expect(run.provider).toBe('ollama')

    const finalRow = await awaitTerminal(run.id)
    expect(finalRow.status).toBe('done')
    expect(finalRow.tokens_in).toBe(100)
    expect(finalRow.tokens_out).toBe(25)
    expect(finalRow.cost_usd).toBe(0)

    const events = runEvents(run.id)
    const statuses = events.filter(e => e.type === 'status').map(e => e.text)
    expect(statuses).toEqual(['queued', 'running', 'done'])
    // The run-start declaration proves the AGENT loop (not `ollama run`) ran.
    expect(events.some(e => e.type === 'system' && (e.text ?? '').startsWith('ollama-agent: model=llama3.2'))).toBe(true)
    expect(events.some(e => e.type === 'assistant' && e.text === 'local answer')).toBe(true)
    expect(transport.requests).toHaveLength(1)
    // The loop resolved run assets for the DEFAULT (orchestrator) profile:
    // native tools were advertised to the model.
    expect((transport.requests[0].tools ?? []).map(t => t.function.name)).toContain('Bash')
    // The supervisor threads the config-store num_ctx into every chat request.
    expect(transport.requests[0].options?.num_ctx).toBe(ollamaNumCtx())
  })

  it('kill() lands as status "killed" through the ActiveProc seam', async () => {
    const transport = makeFakeTransport([{ hang: true }])
    __testHooks.setOllamaTransport(transport)
    const run = await startRun('hang forever', { preferLocal: true, cwd: freshDir('kill') })
    runIds.push(run.id)

    // Wait until the loop's handle is registered, then kill through the
    // supervisor's public seam (the same path /kill and the SIGKILL
    // escalation use).
    await poll(() => (kill(run.id) ? true : undefined))
    const finalRow = await awaitTerminal(run.id)
    expect(finalRow.status).toBe('killed')
    // Operator kill emits no loop-side error event.
    expect(runEvents(run.id).some(e => e.type === 'error')).toBe(false)
  })

  it('endSession() reaches a non-interactive ollama run via the kill path', async () => {
    const transport = makeFakeTransport([{ hang: true }])
    __testHooks.setOllamaTransport(transport)
    const run = await startRun('hang again', { preferLocal: true, cwd: freshDir('end') })
    runIds.push(run.id)
    await poll(() => {
      const row = getRun(run.id)
      return row?.status === 'running' ? true : undefined
    })
    await poll(() => (endSession(run.id) ? true : undefined))
    const finalRow = await awaitTerminal(run.id)
    expect(finalRow.status).toBe('killed')
  })

  it('creates a real worktree for a git cwd and removes it on terminal', async () => {
    const repo = freshGitRepo()
    const transport = makeFakeTransport([
      { chunks: [textChunk('done in worktree'), usageChunk(10, 2)] },
    ])
    __testHooks.setOllamaTransport(transport)
    const run = await startRun('work', { preferLocal: true, cwd: repo })
    runIds.push(run.id)
    expect(run.worktree).toBeTruthy()

    const finalRow = await awaitTerminal(run.id)
    expect(finalRow.status).toBe('done')
    // The run row flips 'done' BEFORE removeWorktree awaits (same ordering as
    // the claude path), so poll for the removal rather than asserting instantly.
    await poll(() => (fs.existsSync(run.worktree!) ? undefined : true))
  }, 30_000)

  // NB the K_OLLAMA_AGENT_MODE=legacy bypass is proven in its OWN file
  // (ollama-legacy-mode.test.ts) with execa mocked — never against a real
  // `ollama` binary/daemon, which could attempt a registry pull and hang CI.
})

describe('ollama.numCtx config (threaded into the loop as options.num_ctx)', () => {
  const ORIG_ENV_CTX = process.env.K_OLLAMA_NUM_CTX

  afterAll(() => {
    if (ORIG_ENV_CTX === undefined) delete process.env.K_OLLAMA_NUM_CTX
    else process.env.K_OLLAMA_NUM_CTX = ORIG_ENV_CTX
    // The app_config row persists in the shared DB — pin it back to the default.
    setOllamaNumCtx(DEFAULT_OLLAMA_NUM_CTX)
    __resetConfigCache()
  })

  it('the two default constants cannot drift (config-store vs loop)', () => {
    expect(DEFAULT_OLLAMA_NUM_CTX).toBe(DEFAULT_NUM_CTX)
  })

  it('defaults to 16384, honors the K_OLLAMA_NUM_CTX env seed while unset, and degrades garbage', () => {
    // No stored row yet (fresh suite DB): env seed applies per read.
    delete process.env.K_OLLAMA_NUM_CTX
    expect(ollamaNumCtx()).toBe(DEFAULT_OLLAMA_NUM_CTX)
    process.env.K_OLLAMA_NUM_CTX = '4096'
    expect(ollamaNumCtx()).toBe(4096)
    process.env.K_OLLAMA_NUM_CTX = 'not-a-number'
    expect(ollamaNumCtx()).toBe(DEFAULT_OLLAMA_NUM_CTX)
    process.env.K_OLLAMA_NUM_CTX = '-5'
    expect(ollamaNumCtx()).toBe(DEFAULT_OLLAMA_NUM_CTX)
  })

  it('a stored value wins over the env seed, floors fractions, and survives a cache reset', () => {
    process.env.K_OLLAMA_NUM_CTX = '4096'
    setOllamaNumCtx(8192.9)
    expect(ollamaNumCtx()).toBe(8192)
    __resetConfigCache()
    expect(ollamaNumCtx()).toBe(8192) // persisted, not just cached
  })
})
