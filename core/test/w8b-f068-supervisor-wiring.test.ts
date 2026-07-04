/**
 * W8b F-068 — the supervisor WIRING that decides gitnexus suppression (MEDIUM-1 + MEDIUM-2).
 *
 * `shouldSuppressGitnexus(run.cwd, !!session)` is the exact predicate runAgent threads into
 * synthesizeConfigDir. This suite locks:
 *   - the PURE predicate: external cwd (outside the K repo) with NO session → suppress; a
 *     K repo cwd → keep; a K-secretary PERSISTENT SESSION → keep EVEN with an external cwd
 *     (K_DATA_DIR may be relocated outside the repo — MEDIUM-1).
 *   - the WIRING: driving the REAL startRun with synthesizeConfigDir mocked (throws before
 *     any spawn) proves runAgent passes suppressGitnexus:true for an external-project dispatch
 *     and :false for a K-secretary session whose cwd (under an external K_DATA_DIR) is itself
 *     outside the repo — guarding a future refactor that might pass the worktree path instead
 *     of run.cwd (MEDIUM-2).
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { isPathWithin } from '../src/paths.js'
import { db } from '../src/db.js'

// synthesizeConfigDir is mocked to RECORD its opts then THROW — so runAgent reaches the
// suppression decision but never spawns claude. Everything else in agent-config stays real
// (kSecretaryConfigPaths, used by startRun's persistent-session branch, must be genuine).
vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('w8b-wiring-stop') }) }
})

const { startRun, shouldSuppressGitnexus, REPO_ROOT } = await import('../src/supervisor.js')
const { synthesizeConfigDir } = await import('../src/agent-config.js')

const tmpDirs: string[] = []
const runIds: string[] = []
const ORIG_KDD = process.env.K_DATA_DIR

function freshExternalDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `k-f068-${tag}-`))
  tmpDirs.push(d)
  return d
}

/** The opts synthesizeConfigDir was last called with. */
function lastSynthOpts(): { suppressGitnexus?: boolean } {
  const call = vi.mocked(synthesizeConfigDir).mock.calls.at(-1)!
  return call[1] as { suppressGitnexus?: boolean }
}

/** Let runAgent's (synchronous-until-first-await) body reach the synthesize call. */
const settle = () => new Promise(r => setTimeout(r, 30))

afterEach(() => {
  if (ORIG_KDD === undefined) delete process.env.K_DATA_DIR
  else process.env.K_DATA_DIR = ORIG_KDD
})
afterAll(() => {
  for (const id of runIds) {
    try { db.prepare('DELETE FROM events WHERE run_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM runs WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('shouldSuppressGitnexus — pure predicate', () => {
  it('an EXTERNAL cwd (outside the K repo) with no session → suppress', () => {
    expect(shouldSuppressGitnexus(freshExternalDir('pure'), false)).toBe(true)
  })
  it('the K repo root (and a subdir) → keep gitnexus', () => {
    expect(shouldSuppressGitnexus(REPO_ROOT, false)).toBe(false)
    expect(shouldSuppressGitnexus(path.join(REPO_ROOT, 'core'), false)).toBe(false)
  })
  it('a K-secretary PERSISTENT SESSION is NEVER external — even with an external cwd (MEDIUM-1)', () => {
    // The exact misclassification: K_DATA_DIR relocated outside REPO_ROOT → the session cwd is
    // external, but a persistent session must still keep gitnexus.
    expect(shouldSuppressGitnexus(freshExternalDir('sess'), true)).toBe(false)
  })
})

describe('runAgent wiring — the value threaded into synthesizeConfigDir', () => {
  it('a dispatch with a project cwd OUTSIDE the repo passes suppressGitnexus:true', async () => {
    const cwd = freshExternalDir('proj') // a non-git external dir → no worktree, falls back to cwd
    const run = await startRun('do the external task', { cwd, model: 'claude-sonnet-4-6' })
    runIds.push(run.id)
    await settle()
    expect(lastSynthOpts().suppressGitnexus).toBe(true)
  })

  it('a K-secretary session whose cwd is under an EXTERNAL K_DATA_DIR passes suppressGitnexus:false (MEDIUM-1)', async () => {
    // Point K_DATA_DIR outside the repo so the persistent-session cwd is provably external…
    const externalDataDir = freshExternalDir('kdd')
    process.env.K_DATA_DIR = externalDataDir
    const run = await startRun('k secretary ask', {
      model: 'claude-sonnet-4-6',
      persistentSession: { key: 'wiring-thread', sessionId: uuid(), resume: false },
    })
    runIds.push(run.id)
    // …the session cwd really is outside the repo…
    expect(isPathWithin(REPO_ROOT, run.cwd, { inclusive: true })).toBe(false)
    await settle()
    // …yet the K-secretary run KEEPS gitnexus.
    expect(lastSynthOpts().suppressGitnexus).toBe(false)
  })
})
