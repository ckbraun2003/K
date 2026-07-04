/**
 * H8 — opt-in carryWorkingTree dispatch mode.
 *
 * A dispatched run normally executes in a fresh `git worktree add --detach` at clean
 * committed HEAD, so it can't see the operator's uncommitted edits. `applyWorkingTreeInto`
 * (opt-in) replays the SOURCE repo's uncommitted tracked+staged WIP into that worktree.
 *
 * These tests drive real git against a throwaway repo (no claude ever spawns) and prove:
 *   a) a modified tracked file is carried into the worktree
 *   b) a STAGED change is carried
 *   c) a clean source + carry is a NO-OP (returns false, worktree stays at HEAD)
 *   d) an UNTRACKED file is NOT carried (documented semantics) — and the source tree is
 *      left untouched (non-destructive capture)
 *   e) DEFAULT PATH proof: `git worktree add --detach` ALONE (no carry) yields a clean
 *      committed-HEAD checkout even when the source is dirty — i.e. omitting the flag is
 *      byte-identical to the prior behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWorkingTreeInto } from '../src/supervisor.js'

const bases: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let repo: string
let worktree: string
const TRACKED = 'tracked.txt'

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-carry-'))
  bases.push(base)
  repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@k.local'])
  git(repo, ['config', 'user.name', 'K Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  // Deterministic line endings: the host's global core.autocrlf=true would rewrite
  // committed '\n' to '\r\n' on checkout and break the exact content assertions.
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, TRACKED), 'committed\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  // git worktree add requires a non-existent target path.
  worktree = path.join(base, 'wt')
})

afterEach(() => {
  for (const b of bases.splice(0)) {
    try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

/** Add the run's detached worktree exactly as startRun does. */
function addWorktree(): void {
  git(repo, ['worktree', 'add', '--detach', worktree])
}
const wtFile = (name = TRACKED) => path.join(worktree, name)
const read = (p: string) => fs.readFileSync(p, 'utf8')

describe('applyWorkingTreeInto (H8 carry mechanism)', () => {
  it('a) carries a modified tracked file into the worktree', async () => {
    addWorktree()
    expect(read(wtFile())).toBe('committed\n') // clean HEAD before carry
    fs.writeFileSync(path.join(repo, TRACKED), 'DIRTY\n') // uncommitted modification

    const applied = await applyWorkingTreeInto(repo, worktree)

    expect(applied).toBe(true)
    expect(read(wtFile())).toBe('DIRTY\n')
    // Non-destructive: the source tree is left exactly as it was.
    expect(read(path.join(repo, TRACKED))).toBe('DIRTY\n')
  })

  it('b) carries a STAGED (index) change into the worktree', async () => {
    addWorktree()
    fs.writeFileSync(path.join(repo, TRACKED), 'STAGED\n')
    git(repo, ['add', TRACKED])

    const applied = await applyWorkingTreeInto(repo, worktree)

    expect(applied).toBe(true)
    expect(read(wtFile())).toBe('STAGED\n')
  })

  it('c) a CLEAN source + carry is a no-op (returns false, worktree stays at HEAD)', async () => {
    addWorktree()

    const applied = await applyWorkingTreeInto(repo, worktree)

    expect(applied).toBe(false)
    expect(read(wtFile())).toBe('committed\n')
  })

  it('d) an UNTRACKED file is NOT carried (documented semantics), tracked WIP alongside IS', async () => {
    addWorktree()
    fs.writeFileSync(path.join(repo, TRACKED), 'DIRTY\n')          // tracked WIP → carried
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'NEW\n')     // untracked → NOT carried

    const applied = await applyWorkingTreeInto(repo, worktree)

    expect(applied).toBe(true)
    expect(read(wtFile())).toBe('DIRTY\n')                         // tracked carried
    expect(fs.existsSync(wtFile('untracked.txt'))).toBe(false)     // untracked left behind
    // The untracked file remains in the source (non-destructive; no stash push -u).
    expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(true)
  })

  it('d2) an ONLY-untracked source is a no-op (nothing to stash → false, worktree untouched)', async () => {
    addWorktree()
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'NEW\n')

    const applied = await applyWorkingTreeInto(repo, worktree)

    expect(applied).toBe(false)
    expect(fs.existsSync(wtFile('untracked.txt'))).toBe(false)
  })

  it('e) DEFAULT PATH: worktree add --detach alone yields clean HEAD even when source is dirty', async () => {
    // Mirrors startRun's default branch (flag absent → applyWorkingTreeInto is never
    // called). A dirty source must NOT bleed into the worktree.
    fs.writeFileSync(path.join(repo, TRACKED), 'DIRTY\n') // source dirty BEFORE add
    addWorktree()
    expect(read(wtFile())).toBe('committed\n') // clean committed HEAD, not the dirty content
  })
})
