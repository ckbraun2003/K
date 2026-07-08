/** P1 W0c — addDetachedWorktree: at HEAD by default, AT a given commit when told. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { addDetachedWorktree } from '../src/supervisor.js'

const bases: string[] = []
let repo: string
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'k-wtb-')); bases.push(base)
  repo = path.join(base, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@k']); git(repo, ['config', 'user.name', 'K'])
  git(repo, ['config', 'commit.gpgsign', 'false']); git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c1'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c2'])
})
afterEach(() => { for (const b of bases.splice(0)) { try { fs.rmSync(b, { recursive: true, force: true }) } catch { /* */ } } })

describe('addDetachedWorktree', () => {
  it('defaults to HEAD', async () => {
    const wt = path.join(path.dirname(repo), 'wt-head')
    await addDetachedWorktree(repo, wt)
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('v2\n')
  })
  it('checks out AT baseCommit when provided', async () => {
    const c1 = git(repo, ['rev-parse', 'HEAD^']).trim()
    const wt = path.join(path.dirname(repo), 'wt-base')
    await addDetachedWorktree(repo, wt, c1)
    expect(git(wt, ['rev-parse', 'HEAD']).trim()).toBe(c1)
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('v1\n')
  })
  it('throws for a non-git cwd (caller falls back to cwd)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-nogit-')); bases.push(dir)
    await expect(addDetachedWorktree(dir, path.join(dir, 'wt'))).rejects.toThrow()
  })
})
