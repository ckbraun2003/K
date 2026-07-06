/**
 * K_OLLAMA_AGENT_MODE=legacy — the escape hatch back to `ollama run` (B3).
 *
 * execa is MOCKED at the module level, so NO real binary or daemon is ever
 * spawned (review finding: a live Ollama would attempt a registry pull for a
 * missing model and could hang an offline/firewalled runner). The mock rejects
 * `git` calls (→ startRun's no-worktree fallback) and resolves the provider
 * spawn instantly, which is enough to prove the dispatch DECISION: with legacy
 * mode set, runAgent takes the execa path — the agent loop's transport is
 * never touched and no `ollama-agent:` run-start event is emitted.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type Spawn = { file: string; args: string[] }
const spawns = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)

vi.mock('execa', () => ({
  execa: (file: string, args?: unknown, _opts?: unknown) => {
    const argv = Array.isArray(args) ? (args as string[]).slice() : []
    spawns.push({ file, args: argv })
    // git calls (worktree probing/creation/removal): reject → startRun's
    // "not a git repo" fallback runs the agent directly in cwd.
    if (file === 'git') return Promise.reject(new Error('mocked: not a git repo'))
    // The provider child (`ollama run …` here): an instantly-exiting fake with
    // the surface runAgent touches (kill/stdin/stdout, awaited result).
    const p = Promise.resolve({ exitCode: 0 }) as Promise<{ exitCode: number }> & {
      kill: (...a: unknown[]) => boolean
      stdin: null
      stdout: null
    }
    p.kill = () => true
    p.stdin = null
    p.stdout = null
    return p
  },
}))

// Imported AFTER the mock so supervisor.ts binds the fake execa.
const { startRun, __testHooks } = await import('../src/supervisor.js')
const { probeOllama } = await import('../src/router.js')
const { setOllamaEnabled, setActiveOllamaModel, activeOllamaModel, __resetConfigCache } = await import('../src/config-store.js')
const { db } = await import('../src/db.js')
const { makeFakeTransport, textChunk, usageChunk } = await import('./helpers/ollama-fakes.js')

const tmpDirs: string[] = []
const runIds: string[] = []
const ORIG_MODE = process.env.K_OLLAMA_AGENT_MODE

beforeAll(async () => {
  setOllamaEnabled(true)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response))
  expect(await probeOllama()).toBe(true)
  vi.unstubAllGlobals()
  process.env.K_OLLAMA_AGENT_MODE = 'legacy'
})

afterAll(async () => {
  __testHooks.setOllamaTransport(null)
  if (ORIG_MODE === undefined) delete process.env.K_OLLAMA_AGENT_MODE
  else process.env.K_OLLAMA_AGENT_MODE = ORIG_MODE
  setOllamaEnabled(false)
  __resetConfigCache()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
  await probeOllama()
  vi.unstubAllGlobals()
  for (const id of runIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

async function poll<T>(fn: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('poll timed out')
}

describe('K_OLLAMA_AGENT_MODE=legacy', () => {
  it('dispatches via execa `ollama run` and never touches the agent loop', async () => {
    const transport = makeFakeTransport([
      { chunks: [textChunk('must never be requested'), usageChunk(1, 1)] },
    ])
    __testHooks.setOllamaTransport(transport)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-legacy-'))
    tmpDirs.push(cwd)

    const run = await startRun('legacy prompt', { preferLocal: true, cwd })
    runIds.push(run.id)
    expect(run.provider).toBe('ollama')

    const finalRow = await poll(() => {
      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id) as { status: string } | undefined
      return row && ['done', 'error', 'killed'].includes(row.status) ? row : undefined
    })
    expect(finalRow.status).toBe('done') // mocked child exits 0

    // The legacy child was spawned with today's argv: run <model> <prompt>.
    const ollamaSpawn = spawns.find((s: Spawn) => s.file === 'ollama')
    expect(ollamaSpawn).toBeDefined()
    expect(ollamaSpawn!.args).toEqual(['run', activeOllamaModel(), 'legacy prompt'])

    // The agent loop never engaged: no chat request, no run-start declaration.
    expect(transport.requests).toHaveLength(0)
    const events = db.prepare('SELECT text FROM events WHERE run_id = ?').all(run.id) as Array<{ text: string | null }>
    expect(events.some(e => (e.text ?? '').startsWith('ollama-agent:'))).toBe(false)
  }, 30_000)
})
