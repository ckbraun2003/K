/** P1 C1 — retention sweep deletes refs for deleted runs only (carry-in #2). */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createCheckpoint, sweepCheckpointRefs } from '../src/checkpoints.js'

const bases: string[] = []
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }
afterEach(() => { for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* */ } } })

describe('sweepCheckpointRefs', () => {
  it('deletes orphaned refs, keeps live ones, skips non-repos', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-sweep-')); bases.push(base)
    const repo = path.join(base, 'repo'); fs.mkdirSync(repo)
    git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@k']); git(repo, ['config', 'user.name', 'K'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'i'])
    const wt = path.join(base, 'wt'); git(repo, ['worktree', 'add', '--detach', wt])
    fs.writeFileSync(path.join(wt, 'b.txt'), 'y\n')
    await createCheckpoint(wt, 'live-run', 1, null)
    fs.writeFileSync(path.join(wt, 'c.txt'), 'z\n')
    await createCheckpoint(wt, 'dead-run', 1, null)

    const n = await sweepCheckpointRefs(
      [repo, repo.toUpperCase(), path.join(base, 'not-a-repo')],   // dup root case-folded; non-repo skipped
      (id) => id === 'live-run',
    )
    expect(n).toBe(1)
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/k-checkpoints/']).trim())
      .toBe('refs/k-checkpoints/live-run')
  })
})
