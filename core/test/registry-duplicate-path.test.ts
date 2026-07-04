/**
 * Wave 5b registry fixes — exercised through the real registerProject against the
 * production db singleton (established pattern; rows cleaned in afterAll):
 *
 *   F-031  a duplicate localPath is rejected (ConflictError → 409) so two projects
 *          can never manage one repo; path is normalized so C:\X and c:\x\ collide.
 *   F-037  registration distinguishes "path does not exist" from "not a git repo".
 *   W4 fu  the repo's real default branch is detected + persisted on the row.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'node:child_process'
import {
  registerProject,
  findProjectByPath,
  normalizePathKey,
  ClientError,
  ConflictError,
} from '../src/projects.js'
import { db } from '../src/db.js'

const tmpDirs: string[] = []
const createdIds: string[] = []

afterAll(() => {
  for (const id of createdIds) {
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}

/** A real git repo on a KNOWN branch (so detectDefaultBranch is deterministic). */
function makeRepo(branch = 'trunk'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-reg-'))
  tmpDirs.push(d)
  git(d, ['init', '-q'])
  git(d, ['config', 'user.email', 'test@example.com'])
  git(d, ['config', 'user.name', 'Test'])
  git(d, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(d, 'README.md'), '# repo\n')
  git(d, ['add', 'README.md'])
  git(d, ['commit', '-q', '-m', 'init'])
  git(d, ['branch', '-M', branch]) // rename the initial branch to a known name
  return d
}

let seq = 0
const uniqueName = (base: string) => `${base}-${Date.now().toString(36)}-${seq++}`

async function register(name: string, localPath: string) {
  const p = await registerProject({ name, localPath })
  createdIds.push(p.id)
  return p
}

// ── normalizePathKey / findProjectByPath (pure) ────────────────────────────────

describe('normalizePathKey', () => {
  it('resolves and drops trailing separators so a trailing-slash variant collides', () => {
    const base = path.join(os.tmpdir(), 'k-norm-x')
    expect(normalizePathKey(base)).toBe(normalizePathKey(base + path.sep))
  })

  it('is case-insensitive on Windows only', () => {
    const base = path.join(os.tmpdir(), 'CaseTest')
    if (process.platform === 'win32') {
      expect(normalizePathKey(base)).toBe(normalizePathKey(base.toLowerCase()))
    } else {
      expect(normalizePathKey(base)).not.toBe(normalizePathKey(base.toLowerCase()))
    }
  })
})

// ── F-031 duplicate localPath ──────────────────────────────────────────────────

describe('F-031: a duplicate localPath is rejected', () => {
  it('the 2nd registration of the SAME path (new name) is a ConflictError naming the 1st project', async () => {
    const repo = makeRepo()
    const first = await register(uniqueName('dup-first'), repo)

    await expect(register(uniqueName('dup-second'), repo)).rejects.toBeInstanceOf(ConflictError)
    // and the message names the conflicting project
    await expect(register(uniqueName('dup-third'), repo)).rejects.toThrow(new RegExp(first.name))

    // findProjectByPath resolves the same repo regardless of a trailing separator.
    expect(findProjectByPath(repo)?.id).toBe(first.id)
    expect(findProjectByPath(repo + path.sep)?.id).toBe(first.id)
  })

  it('a genuinely DIFFERENT path still registers fine', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const a = await register(uniqueName('diff-a'), repoA)
    const b = await register(uniqueName('diff-b'), repoB)
    expect(a.id).not.toBe(b.id)
    expect(findProjectByPath(repoB)?.id).toBe(b.id)
  })
})

// ── F-037 distinct validation messages ─────────────────────────────────────────

describe('F-037: register distinguishes "does not exist" from "not a git repository"', () => {
  it('a non-existent path → "path does not exist"', async () => {
    const missing = path.join(os.tmpdir(), `k-nope-${Date.now()}`)
    await expect(registerProject({ name: uniqueName('nx'), localPath: missing }))
      .rejects.toThrow(/path does not exist/)
  })

  it('an existing NON-git dir → "not a git repository" (a distinct message)', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'k-plain-'))
    tmpDirs.push(plain)
    let msg = ''
    try {
      await registerProject({ name: uniqueName('ng'), localPath: plain })
    } catch (e) {
      expect(e).toBeInstanceOf(ClientError)
      msg = (e as Error).message
    }
    expect(msg).toMatch(/not a git repository/)
    expect(msg).not.toMatch(/does not exist/)
  })
})

// ── W4 follow-up: persisted default branch ─────────────────────────────────────

describe('default branch is detected + persisted at registration', () => {
  it('stores the repo\'s real current branch on the Project row', async () => {
    const repo = makeRepo('trunk')
    const p = await register(uniqueName('db-detect'), repo)
    expect(p.defaultBranch).toBe('trunk')
    const row = db.prepare('SELECT default_branch FROM projects WHERE id = ?').get(p.id) as { default_branch: string }
    expect(row.default_branch).toBe('trunk')
  })
})
