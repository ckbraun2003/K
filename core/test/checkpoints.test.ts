/**
 * Lane B (P0) — k-checkpoint commits (E-03 groundwork).
 *
 * Real git against a throwaway repo + detached worktree (the exact startRun
 * layout; no claude ever spawns). Proves:
 *   a) a dirty worktree checkpoint creates a `k-checkpoint: <runId> wave <n>`
 *      commit on refs/k-checkpoints/<runId>, leaving HEAD, the real index, and
 *      the working files untouched;
 *   b) an unchanged tree is a no-op (null) — wave not consumed;
 *   c) wave 2 chains onto wave 1 (parent linkage) and moves the ref;
 *   d) PR-isolation: a branch created in the worktree AFTER checkpoints
 *      contains NO k-checkpoint commit (checkpoints can never pollute a PR).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCheckpoint, type CheckpointInfo } from '../src/checkpoints.js'

const bases: string[] = []
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ckpt-'))
  bases.push(base)
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@k.local'])
  git(repo, ['config', 'user.name', 'K Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  worktree = path.join(base, 'wt')
  git(repo, ['worktree', 'add', '--detach', worktree]) // exactly startRun's layout
})

afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('createCheckpoint', () => {
  it('a) snapshots a dirty worktree without touching HEAD, the index, or files', async () => {
    const headBefore = git(worktree, ['rev-parse', 'HEAD']).trim()
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'agent work\n')
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'edited\n')
    const statusBefore = git(worktree, ['status', '--porcelain'])

    const res = await createCheckpoint(worktree, 'run-1', 1, null)

    expect(res).not.toBeNull()
    const { sha, ref, wave } = res as CheckpointInfo
    expect(wave).toBe(1)
    expect(ref).toBe('refs/k-checkpoints/run-1')
    expect(git(repo, ['log', '-1', '--format=%s', sha]).trim()).toBe('k-checkpoint: run-1 wave 1')
    expect(git(repo, ['show', `${sha}:new.txt`])).toBe('agent work\n')
    expect(git(repo, ['show', `${sha}:a.txt`])).toBe('edited\n')
    expect(git(repo, ['rev-parse', 'refs/k-checkpoints/run-1']).trim()).toBe(sha)
    // HEAD, the real index/status, and the files are untouched.
    expect(git(worktree, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(git(worktree, ['status', '--porcelain'])).toBe(statusBefore)
    expect(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8')).toBe('agent work\n')
  })

  it('b) unchanged tree → null (no commit, wave not consumed)', async () => {
    expect(await createCheckpoint(worktree, 'run-1', 1, null)).toBeNull() // clean = base HEAD tree
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'v1\n')
    const first = await createCheckpoint(worktree, 'run-1', 1, null)
    expect(first).not.toBeNull()
    expect(await createCheckpoint(worktree, 'run-1', 2, first)).toBeNull() // no change since wave 1
  })

  it('c) wave 2 chains onto wave 1 and moves the ref', async () => {
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'v1\n')
    const w1 = (await createCheckpoint(worktree, 'run-1', 1, null)) as CheckpointInfo
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'v2\n')
    const w2 = (await createCheckpoint(worktree, 'run-1', 2, w1)) as CheckpointInfo
    expect(w2.wave).toBe(2)
    expect(git(repo, ['rev-parse', `${w2.sha}^`]).trim()).toBe(w1.sha)
    expect(git(repo, ['rev-parse', 'refs/k-checkpoints/run-1']).trim()).toBe(w2.sha)
  })

  it('d) a branch created after checkpoints contains NO k-checkpoint commit', async () => {
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'v1\n')
    await createCheckpoint(worktree, 'run-1', 1, null)
    git(worktree, ['checkout', '-q', '-b', 'feat/agent-branch'])
    git(worktree, ['add', '.'])
    git(worktree, ['-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '-q', '-m', 'real work'])
    const log = git(worktree, ['log', '--format=%s'])
    expect(log).toContain('real work')
    expect(log).not.toContain('k-checkpoint')
  })
})
