/**
 * H8 (interaction lock) — carryWorkingTree is a SILENT NO-OP under a persistent session.
 *
 * startRun's branching is `if (ps) { …stable cwd, NO worktree… } else { …worktree add,
 * applyWorkingTreeInto… }`, so carry is STRUCTURALLY UNREACHABLE when a persistent
 * session (K-secretary) is set — carry lives only in the `else` arm. This is correct by
 * inspection, but nothing asserted it, so a future refactor that flattens the branching
 * could reintroduce a worktree/carry side-effect (or a crash) under a persistent session
 * undetected. This test pins the invariant: with BOTH `persistentSession` AND
 * `carryWorkingTree:true`, the persistent-session behavior is unchanged — no worktree is
 * created, no carry runs, and startRun does not throw.
 *
 * Reuses the W7a/W8b scaffolding: synthesizeConfigDir is mocked to throw before any spawn
 * so runAgent never launches claude, while kSecretaryConfigPaths (the persistent-session
 * cwd source) stays real.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db } from '../src/db.js'

// synthesizeConfigDir throws before any claude spawn (runAgent reaches it, then aborts);
// kSecretaryConfigPaths — used by startRun's persistent-session branch — stays real.
vi.mock('../src/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent-config.js')>('../src/agent-config.js')
  return { ...actual, synthesizeConfigDir: vi.fn(() => { throw new Error('carry-ps-wiring-stop') }) }
})

const { startRun, REPO_ROOT } = await import('../src/supervisor.js')
const { kSecretaryConfigPaths } = await import('../src/agent-config.js')

const runIds: string[] = []
const tmpDirs: string[] = []
const ORIG_KDD = process.env.K_DATA_DIR

/** Let runAgent's synchronous-until-first-await body settle (the mock throws in it). */
const settle = () => new Promise((r) => setTimeout(r, 30))

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

describe('startRun — carryWorkingTree is a silent no-op under a persistent session (H8)', () => {
  it('a persistentSession + carryWorkingTree:true takes the stable-cwd branch: no worktree, no carry, no throw', async () => {
    // Isolate the K-secretary stable cwd under a throwaway K_DATA_DIR.
    const kdd = fs.mkdtempSync(path.join(os.tmpdir(), 'k-carry-ps-'))
    tmpDirs.push(kdd)
    process.env.K_DATA_DIR = kdd
    const key = 'carry-ps-thread'

    // startRun must NOT throw even though carry is requested alongside a persistent session.
    const run = await startRun('k secretary ask', {
      model: 'claude-sonnet-4-6',
      persistentSession: { key, sessionId: uuid(), resume: false },
      carryWorkingTree: true, // requested, but structurally unreachable under `ps`
    })
    runIds.push(run.id)

    // 1) Persistent-session branch was taken: the run has NO worktree...
    expect(run.worktree).toBeUndefined()
    // ...and its cwd is the STABLE per-thread K-secretary cwd, not a worktree path.
    expect(run.cwd).toBe(kSecretaryConfigPaths(key).cwd)

    // 2) No worktree dir was created on disk for this run (carry is only reachable in
    //    the `else` arm that first runs `git worktree add` — proving it never ran).
    expect(fs.existsSync(path.join(REPO_ROOT, '.worktrees', run.id))).toBe(false)

    // 3) The persisted runs row confirms the worktree column is null (never set/cleared).
    const row = db.prepare('SELECT worktree FROM runs WHERE id = ?').get(run.id) as { worktree: string | null }
    expect(row.worktree).toBeNull()

    // Let runAgent's aborted body settle so no spawn/timer leaks into later tests.
    await settle()
  })
})
