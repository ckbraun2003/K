import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Project } from '@k/shared'
import { onboardProject, ensureGitignore } from '../src/onboard.js'
import { hasBibleDir } from '../src/verify.js'

// ── temp dir helpers ───────────────────────────────────────────────────────────

const tmps: string[] = []

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-onboard-'))
  tmps.push(d)
  return d
}

afterEach(() => {
  for (const d of tmps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** Minimal Project fixture — only the fields onboardProject inspects. */
function makeProject(localPath: string, githubRemote?: string): Project {
  return {
    id: 'test-id',
    name: 'test-project',
    localPath,
    githubRemote,
    workspaceManaged: false,
    bibleDir: 'artifacts/bible',
    createdAt: Date.now(),
  }
}

// ── bare dir: both invariants missing ─────────────────────────────────────────

describe('onboardProject — bare directory', () => {
  it('scaffolds bible + CI and reports both dirs created', () => {
    const tmp = makeTmp()
    const result = onboardProject(makeProject(tmp, 'owner/repo'))

    // should have created 6 bible files + 1 CI file + .gitignore = 8 total
    expect(result.created).toHaveLength(8)
    expect(result.created).toContain('artifacts/bible/manifest.json')
    expect(result.created).toContain('.github/workflows/ci.yml')
    expect(result.created).toContain('.gitignore')
    for (const id of ['01-vision','02-architecture','03-roadmap','04-decision-log','05-operations']) {
      expect(result.created).toContain(`artifacts/bible/sections/${id}.md`)
    }
  })

  it('scaffold target matches the verify bibleDir (round-trip: verify finds the bible)', () => {
    const tmp = makeTmp()
    const project = makeProject(tmp, 'owner/repo')
    onboardProject(project)
    // verify reads project.bibleDir off the project/DB row — it must point at the
    // SAME dir scaffold wrote to, or a freshly registered project fails verification
    // with a spurious "no bible" critical finding (Wave 5 regression guard).
    expect(hasBibleDir(tmp, project.bibleDir)).toBe(true)
    expect(hasBibleDir(tmp, 'docs/bible')).toBe(false)
  })

  it('invariants.bible and invariants.ci are true after onboarding', () => {
    const tmp = makeTmp()
    const result = onboardProject(makeProject(tmp, 'owner/repo'))
    expect(result.invariants.bible).toBe(true)
    expect(result.invariants.ci).toBe(true)
  })

  it('invariants.githubRemote is true when project has a remote', () => {
    const tmp = makeTmp()
    const result = onboardProject(makeProject(tmp, 'owner/repo'))
    expect(result.invariants.githubRemote).toBe(true)
  })

  it('invariants.githubRemote is false when project has no remote', () => {
    const tmp = makeTmp()
    const result = onboardProject(makeProject(tmp, undefined))
    expect(result.invariants.githubRemote).toBe(false)
  })

  it('all reported created paths exist on disk', () => {
    const tmp = makeTmp()
    const { created } = onboardProject(makeProject(tmp))
    for (const rel of created) {
      expect(fs.existsSync(path.join(tmp, ...rel.split('/'))), rel).toBe(true)
    }
  })
})

// ── idempotency ────────────────────────────────────────────────────────────────

describe('onboardProject — idempotency', () => {
  it('second call returns created:[] and all invariants still true', () => {
    const tmp = makeTmp()
    const p = makeProject(tmp, 'owner/repo')
    onboardProject(p)
    const second = onboardProject(p)

    expect(second.created).toEqual([])
    expect(second.invariants.bible).toBe(true)
    expect(second.invariants.ci).toBe(true)
    expect(second.invariants.githubRemote).toBe(true)
  })

  it('does not overwrite sentinel content on second run', () => {
    const tmp = makeTmp()
    const p = makeProject(tmp)
    onboardProject(p)

    const manifestPath = path.join(tmp, 'artifacts', 'bible', 'manifest.json')
    const sentinel = '/* sentinel */'
    fs.appendFileSync(manifestPath, sentinel)

    onboardProject(p)
    expect(fs.readFileSync(manifestPath, 'utf8')).toContain(sentinel)
  })
})

// ── partial onboarding ─────────────────────────────────────────────────────────

describe('onboardProject — partial onboarding', () => {
  it('bible present (real manifest), CI absent: only CI is scaffolded', () => {
    const tmp = makeTmp()
    // pre-create a real bible (manifest.json sentinel) so the bible check passes
    fs.mkdirSync(path.join(tmp, 'artifacts', 'bible'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'artifacts', 'bible', 'manifest.json'), '{}')

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    // no bible paths in created
    expect(created.some(p => p.startsWith('artifacts/bible/'))).toBe(false)
    // CI was scaffolded
    expect(created).toContain('.github/workflows/ci.yml')
    expect(invariants.bible).toBe(true)
    expect(invariants.ci).toBe(true)
  })

  it('empty artifacts/bible dir (no manifest) is NOT treated as onboarded — bible is scaffolded', () => {
    const tmp = makeTmp()
    // an empty artifacts/bible dir must not satisfy the bible invariant
    fs.mkdirSync(path.join(tmp, 'artifacts', 'bible'), { recursive: true })

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    expect(created).toContain('artifacts/bible/manifest.json')
    expect(invariants.bible).toBe(true)
  })

  it('CI present (real workflow file), bible absent: only bible is scaffolded', () => {
    const tmp = makeTmp()
    // pre-create .github/workflows/ WITH a real workflow file so the CI invariant
    // is genuinely satisfied (an empty dir does NOT count — see test below).
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'existing.yml'), 'name: CI\n')

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    // no CI path in created
    expect(created).not.toContain('.github/workflows/ci.yml')
    // bible was scaffolded
    expect(created).toContain('artifacts/bible/manifest.json')
    expect(invariants.bible).toBe(true)
    expect(invariants.ci).toBe(true)
  })

  it('empty .github/workflows/ dir (no yml file) is NOT treated as CI-onboarded — ci.yml is scaffolded', () => {
    const tmp = makeTmp()
    // an empty workflows dir must not satisfy the CI invariant (matches verify.ts)
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    expect(created).toContain('.github/workflows/ci.yml')
    expect(invariants.ci).toBe(true)

    // idempotent: a second run scaffolds nothing new and CI stays satisfied
    const second = onboardProject(makeProject(tmp, 'owner/repo'))
    expect(second.created).toEqual([])
    expect(second.invariants.ci).toBe(true)
  })
})

// ── gitignore (hides K-system artifacts/ + tasks/) ───────────────────────────────

function readLines(p: string): string[] {
  return fs.readFileSync(p, 'utf8').split('\n').map(l => l.trim())
}

describe('onboardProject — gitignore', () => {
  it('ensures .gitignore ignores compiled artifacts/*.html and tasks/ (but NOT the bible sources), and is idempotent', () => {
    const tmp = makeTmp()
    const p = makeProject(tmp, 'owner/repo')

    const first = onboardProject(p)
    expect(first.created).toContain('.gitignore')

    const gi = path.join(tmp, '.gitignore')
    const lines = readLines(gi)
    expect(lines).toContain('artifacts/*.html')
    expect(lines).toContain('tasks/')
    // the bible SOURCES must stay tracked — a blanket `artifacts/` would ignore them
    expect(lines).not.toContain('artifacts/')

    // second call: gitignore already satisfied — no .gitignore in created, no dup lines
    const second = onboardProject(p)
    expect(second.created).not.toContain('.gitignore')
    expect(readLines(gi).filter(l => l === 'artifacts/*.html')).toHaveLength(1)
    expect(readLines(gi).filter(l => l === 'tasks/')).toHaveLength(1)
  })
})

describe('ensureGitignore', () => {
  it('absent: creates .gitignore with both entries and returns [.gitignore]', () => {
    const tmp = makeTmp()
    const out = ensureGitignore(tmp)
    expect(out).toEqual(['.gitignore'])
    const lines = readLines(path.join(tmp, '.gitignore'))
    expect(lines).toContain('artifacts/*.html')
    expect(lines).toContain('tasks/')
  })

  it('present with one entry: appends only the missing one, no duplicates', () => {
    const tmp = makeTmp()
    const gi = path.join(tmp, '.gitignore')
    fs.writeFileSync(gi, 'node_modules/\nartifacts/*.html\n', 'utf8')

    const out = ensureGitignore(tmp)
    expect(out).toEqual(['.gitignore'])

    const lines = readLines(gi)
    expect(lines.filter(l => l === 'artifacts/*.html')).toHaveLength(1)
    expect(lines.filter(l => l === 'tasks/')).toHaveLength(1)
    // pre-existing unrelated entry is preserved
    expect(lines).toContain('node_modules/')
  })

  it('appends a trailing newline before missing entry when file lacks one', () => {
    const tmp = makeTmp()
    const gi = path.join(tmp, '.gitignore')
    fs.writeFileSync(gi, 'artifacts/*.html', 'utf8') // no trailing newline

    ensureGitignore(tmp)
    const lines = readLines(gi)
    expect(lines.filter(l => l === 'artifacts/*.html')).toHaveLength(1)
    expect(lines).toContain('tasks/')
  })

  it('present with both entries: no change, returns []', () => {
    const tmp = makeTmp()
    const gi = path.join(tmp, '.gitignore')
    const original = 'artifacts/*.html\ntasks/\n'
    fs.writeFileSync(gi, original, 'utf8')

    const out = ensureGitignore(tmp)
    expect(out).toEqual([])
    expect(fs.readFileSync(gi, 'utf8')).toBe(original)
  })

  it('migrates a legacy blanket `artifacts/` (old K policy) to `artifacts/*.html`, self-healing', () => {
    const tmp = makeTmp()
    const gi = path.join(tmp, '.gitignore')
    // A project onboarded by an OLDER K: the blanket `artifacts/` ignores the bible sources.
    fs.writeFileSync(gi, 'node_modules/\nartifacts/\ntasks/\n', 'utf8')

    const out = ensureGitignore(tmp)
    expect(out).toEqual(['.gitignore'])

    const lines = readLines(gi)
    // the blanket line is gone; the finer-grained one replaces it; tasks/ kept; unrelated kept
    expect(lines).not.toContain('artifacts/')
    expect(lines.filter(l => l === 'artifacts/*.html')).toHaveLength(1)
    expect(lines.filter(l => l === 'tasks/')).toHaveLength(1)
    expect(lines).toContain('node_modules/')

    // idempotent after migration: a second call is a no-op
    expect(ensureGitignore(tmp)).toEqual([])
  })
})
