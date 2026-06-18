import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Project } from '@k/shared'
import { onboardProject } from '../src/onboard.js'

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
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  }
}

// ── bare dir: both invariants missing ─────────────────────────────────────────

describe('onboardProject — bare directory', () => {
  it('scaffolds bible + CI and reports both dirs created', () => {
    const tmp = makeTmp()
    const result = onboardProject(makeProject(tmp, 'owner/repo'))

    // should have created 6 bible files + 1 CI file = 7 total
    expect(result.created).toHaveLength(7)
    expect(result.created).toContain('docs/bible/manifest.json')
    expect(result.created).toContain('.github/workflows/ci.yml')
    for (const id of ['01-vision','02-architecture','03-roadmap','04-decision-log','05-operations']) {
      expect(result.created).toContain(`docs/bible/sections/${id}.md`)
    }
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

    const manifestPath = path.join(tmp, 'docs', 'bible', 'manifest.json')
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
    fs.mkdirSync(path.join(tmp, 'docs', 'bible'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'bible', 'manifest.json'), '{}')

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    // no bible paths in created
    expect(created.some(p => p.startsWith('docs/bible/'))).toBe(false)
    // CI was scaffolded
    expect(created).toContain('.github/workflows/ci.yml')
    expect(invariants.bible).toBe(true)
    expect(invariants.ci).toBe(true)
  })

  it('empty docs/bible dir (no manifest) is NOT treated as onboarded — bible is scaffolded', () => {
    const tmp = makeTmp()
    // an empty docs/bible dir must not satisfy the bible invariant
    fs.mkdirSync(path.join(tmp, 'docs', 'bible'), { recursive: true })

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    expect(created).toContain('docs/bible/manifest.json')
    expect(invariants.bible).toBe(true)
  })

  it('CI present, bible absent: only bible is scaffolded', () => {
    const tmp = makeTmp()
    // pre-create .github/workflows/ so CI check passes
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })

    const { created, invariants } = onboardProject(makeProject(tmp, 'owner/repo'))

    // no CI path in created
    expect(created).not.toContain('.github/workflows/ci.yml')
    // bible was scaffolded
    expect(created).toContain('docs/bible/manifest.json')
    expect(invariants.bible).toBe(true)
    expect(invariants.ci).toBe(true)
  })
})
