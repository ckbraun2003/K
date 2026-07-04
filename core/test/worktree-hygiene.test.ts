/**
 * Worktree lifecycle hygiene — F-091 (prune ordering) + H7 (removeWorktree retry).
 *
 * F-091: sweepOrphanWorktrees must run `git worktree prune` AFTER removing the physical
 * dirs, so metadata for a dir removed THIS boot is reclaimed the same boot (previously
 * prune ran first, leaving it registered as 'prunable' until the NEXT boot). Driven
 * against a real throwaway git repo.
 *
 * H7: removeWorktreeWithRetry retries a transient failure with backoff before a final
 * best-effort swallow — a transient EBUSY (lingering Windows child handle) must not leak
 * the worktree, and a persistent failure must never throw. Driven with an injected
 * attempt fn + no-op sleep (no real git / no real timers).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepOrphanWorktrees, removeWorktreeWithRetry } from '../src/supervisor.js'

const bases: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let repo: string
let worktreesDir: string

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-wt-hygiene-'))
  bases.push(base)
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@k.local'])
  git(repo, ['config', 'user.name', 'K Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  worktreesDir = path.join(repo, '.worktrees')
  fs.mkdirSync(worktreesDir)
})

afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('sweepOrphanWorktrees (F-091 prune-after-removal)', () => {
  it('removes an orphan dir AND reclaims its git metadata in the SAME sweep', async () => {
    const orphan = 'orphan-run-1'
    git(repo, ['worktree', 'add', '--detach', path.join(worktreesDir, orphan)])
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(orphan)

    sweepOrphanWorktrees(repo, worktreesDir, new Set())

    // The physical dir is gone...
    expect(fs.existsSync(path.join(worktreesDir, orphan))).toBe(false)
    // ...AND git's metadata for it was pruned THIS sweep (the F-091 fix — prune ran
    // after the removal, so nothing is left registered as prunable).
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(orphan)
  })

  it('preserves a worktree still held by an active run', () => {
    const active = 'active-run-1'
    git(repo, ['worktree', 'add', '--detach', path.join(worktreesDir, active)])

    sweepOrphanWorktrees(repo, worktreesDir, new Set([active]))

    expect(fs.existsSync(path.join(worktreesDir, active))).toBe(true)
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(active)
  })

  it('is a no-op (never throws) when the worktrees dir does not exist', () => {
    expect(() => sweepOrphanWorktrees(repo, path.join(repo, 'nope'), new Set())).not.toThrow()
  })
})

describe('removeWorktreeWithRetry (H7)', () => {
  const noSleep = () => Promise.resolve()

  it('recovers from a transient failure then succeeds (cleans up)', async () => {
    let calls = 0
    const attempt = () => {
      calls++
      if (calls === 1) return Promise.reject(new Error('EBUSY'))
      return Promise.resolve()
    }
    const ok = await removeWorktreeWithRetry(attempt, { sleep: noSleep })
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('a persistent failure returns false and NEVER throws (cleanup best-effort)', async () => {
    let calls = 0
    const attempt = () => { calls++; return Promise.reject(new Error('EBUSY')) }
    const ok = await removeWorktreeWithRetry(attempt, { attempts: 3, sleep: noSleep })
    expect(ok).toBe(false)
    expect(calls).toBe(3) // exhausted all attempts, swallowed
  })

  it('the happy path succeeds on the first attempt with no retry', async () => {
    let calls = 0
    const attempt = () => { calls++; return Promise.resolve() }
    const ok = await removeWorktreeWithRetry(attempt, { sleep: noSleep })
    expect(ok).toBe(true)
    expect(calls).toBe(1)
  })
})
