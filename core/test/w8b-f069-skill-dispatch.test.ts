/**
 * W8b F-069 — skill "▶ run" dispatches the skill's CONTENTS (execute-instruction) against
 * an optionally-chosen project, not the literal SKILL.md PATH.
 *
 * Before: triggerSkill did startRun(skill.source) where source is a FILE PATH, so the agent
 * just read+summarized the skill and exited (a $-costing no-op), always against K. Now the
 * run prompt is an EXECUTE instruction wrapping the skill's actual contents (readSkillSource
 * → buildSkillRunPrompt), and an optional projectId threads the project's checkout through as
 * the run's cwd. buildEvalPrompt embeds the contents too.
 *
 * supervisor.startRun is mocked (captures its args; inserts a real runs row) so no agent
 * spawns. Route-level projectId validation is driven through the real Fastify app (buildApp,
 * bootstrap skipped) with app.inject. Isolated DB via vitest.config.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import type { FastifyInstance } from 'fastify'
import type { Skill } from '@k/shared'
import { db, projectsDb } from '../src/db.js'
import { isPathWithin } from '../src/paths.js'

// The K repo root + a LEGIT built-in skill under agent-config/skills/ — the ONLY place
// readSkillSource will read a file from (F-069 security confinement).
const TEST_REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../')
const SKILLS_ROOT_ABS = path.join(TEST_REPO_ROOT, 'agent-config', 'skills')
const LEGIT_REL = 'agent-config/skills/onboarding/SKILL.md'
const LEGIT_ABS = path.join(TEST_REPO_ROOT, LEGIT_REL)
const LEGIT_CONTENTS = fs.readFileSync(LEGIT_ABS, 'utf8')

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  const { db } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    startRun: vi.fn(async () => {
      const id = `mock-f069-run-${uuid().slice(0, 8)}`
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, prompt, cwd, status, created_at) VALUES (?, 'f069', '.', 'queued', ?)`,
      ).run(id, Date.now())
      return { id }
    }),
    kill: vi.fn(() => false),
  }
})

const { startRun } = await import('../src/supervisor.js')
const { triggerSkill, buildSkillRunPrompt, readSkillSource, registerSkill } = await import('../src/skills.js')

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const SFX = uuid().slice(0, 8)
const tmpFiles: string[] = []
const createdSkillNames: string[] = []
const PROJECT_ID = uuid()
const PROJECT_PATH = path.join(os.tmpdir(), `k-f069-proj-${SFX}`)
let app: FastifyInstance

/** Write a throwaway SKILL.md and return its absolute path (a valid skill.source). */
function writeSkillFile(contents: string): string {
  const p = path.join(os.tmpdir(), `k-f069-skill-${uuid().slice(0, 8)}.md`)
  fs.writeFileSync(p, contents, 'utf8')
  tmpFiles.push(p)
  return p
}

function makeSkill(source: string): Skill {
  const name = `f069-skill-${SFX}-${createdSkillNames.length}`
  createdSkillNames.push(name)
  return registerSkill({ name, type: 'workflow', source, triggerType: 'manual' })
}

/** The args startRun was last called with. */
function lastStartRun(): { prompt: string; opts: Record<string, unknown> } {
  const call = vi.mocked(startRun).mock.calls.at(-1)!
  return { prompt: String(call[0]), opts: (call[1] ?? {}) as Record<string, unknown> }
}

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  fs.mkdirSync(PROJECT_PATH, { recursive: true })
  projectsDb.insertProject.run({
    id: PROJECT_ID, name: `f069-proj-${SFX}`, localPath: PROJECT_PATH,
    githubRemote: null, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  // FK-safe order: skill_runs (by our skills) → skills → orphan mock runs → project.
  try { db.prepare(`DELETE FROM skill_runs WHERE skillId IN (SELECT id FROM skills WHERE name LIKE ?)`).run(`f069-skill-${SFX}-%`) } catch { /* ignore */ }
  for (const n of createdSkillNames) { try { db.prepare('DELETE FROM skills WHERE name = ?').run(n) } catch { /* ignore */ } }
  try { db.prepare(`DELETE FROM runs WHERE id LIKE 'mock-f069-run-%'`).run() } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID) } catch { /* ignore */ }
  for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }) } catch { /* ignore */ } }
  try { fs.rmSync(PROJECT_PATH, { recursive: true, force: true }) } catch { /* ignore */ }
  await app.close()
})

describe('readSkillSource — in-root path → CONTENTS, confined (F-069 security)', () => {
  it('reads the CONTENTS of a legit SKILL.md UNDER agent-config/skills/', () => {
    const skill = makeSkill(LEGIT_REL)
    const resolved = readSkillSource(skill)
    expect(resolved).toBe(LEGIT_CONTENTS) // the real file contents
    expect(resolved).not.toBe(LEGIT_REL) // NOT the bare path
    expect(resolved.length).toBeGreaterThan(LEGIT_REL.length)
  })

  it('returns an inline (non-file) source verbatim', () => {
    const skill = makeSkill('just do the thing inline')
    expect(readSkillSource(skill)).toBe('just do the thing inline')
  })

  it('does NOT read a file at an ABSOLUTE path outside the skills root — treats it as raw text', () => {
    // The exact exfiltration vector: an authenticated caller points source at a secret file.
    const secretPath = writeSkillFile('SUPER-SECRET-TOKEN=abc123')
    const skill = makeSkill(secretPath)
    const resolved = readSkillSource(skill)
    expect(resolved).toBe(secretPath) // the raw source string, NOT the file contents
    expect(resolved).not.toContain('SUPER-SECRET-TOKEN') // the secret is never read off disk
  })

  it('does NOT read an existing, readable file OUTSIDE the skills root (in-repo, out-of-root)', () => {
    // package.json exists + is readable, but lives OUTSIDE agent-config/skills → confinement
    // must still refuse to read it and treat the source as raw text.
    const skill = makeSkill('package.json')
    const resolved = readSkillSource(skill)
    expect(resolved).toBe('package.json')
    expect(resolved).not.toContain('"dependencies"')
  })

  it('does NOT read a file via `..` traversal escaping the skills root', () => {
    const traversal = 'agent-config/skills/../../package.json'
    const skill = makeSkill(traversal)
    const resolved = readSkillSource(skill)
    expect(resolved).toBe(traversal) // raw — the escape is refused
    expect(resolved).not.toContain('"dependencies"')
  })

  it('does NOT read through a SYMLINK planted IN-root that points OUTSIDE the repo (realpath guard)', () => {
    // The bypass the string check misses: a symlink whose STRING path is in-root
    // (agent-config/skills/…) but whose REAL target is an outside secret. The
    // realpathSync confinement must refuse it and fall back to the raw source.
    const secretPath = writeSkillFile('SUPER-SECRET-SYMLINK-TARGET=xyz789')
    const linkRel = `agent-config/skills/f069-evil-${uuid().slice(0, 8)}.md`
    const linkAbs = path.join(TEST_REPO_ROOT, linkRel)
    try {
      fs.symlinkSync(secretPath, linkAbs)
    } catch {
      // Windows may require privileges/dev-mode for symlink creation (EPERM). Skip
      // ONLY this realpath sub-assertion where symlinks are unavailable — the
      // non-symlink confinement cases above still run everywhere.
      return
    }
    tmpFiles.push(linkAbs)
    // Sanity: the string-level guard alone would PASS this (it resolves in-root),
    // so this genuinely exercises the realpath gate.
    expect(isPathWithin(SKILLS_ROOT_ABS, linkAbs)).toBe(true)
    const skill = makeSkill(linkRel)
    const resolved = readSkillSource(skill)
    expect(resolved).toBe(linkRel) // raw — the symlink escape is refused
    expect(resolved).not.toContain('SUPER-SECRET-SYMLINK-TARGET') // secret never read off disk
  })
})

describe('buildSkillRunPrompt — EXECUTE instruction wrapping the contents (F-069)', () => {
  it('is an execute-instruction embedding the skill contents, not the bare path', () => {
    const skill = makeSkill(LEGIT_REL)
    const prompt = buildSkillRunPrompt(skill)
    expect(prompt).toMatch(/Execute the following skill/i)
    expect(prompt).toContain(LEGIT_CONTENTS)
    expect(prompt).not.toBe(skill.source)
    expect(prompt).not.toBe(LEGIT_REL)
  })
})

describe('triggerSkill — prompt is the contents; projectId threads the cwd', () => {
  it('dispatches the EXECUTE-contents prompt (not the path), against K when no project', async () => {
    const skill = makeSkill(LEGIT_REL)
    await triggerSkill(skill.id, 'manual')
    const { prompt, opts } = lastStartRun()
    expect(prompt).toContain(LEGIT_CONTENTS)
    expect(prompt).not.toBe(LEGIT_REL)
    // No project selected → no cwd threaded (runs against K, exactly as before).
    expect(opts.cwd).toBeUndefined()
    expect(opts.projectId).toBeUndefined()
  })

  it('threads the chosen project cwd + projectId into the dispatch', async () => {
    const skill = makeSkill('inline body')
    await triggerSkill(skill.id, 'manual', { projectId: PROJECT_ID })
    const { opts } = lastStartRun()
    expect(opts.cwd).toBe(PROJECT_PATH)
    expect(opts.projectId).toBe(PROJECT_ID)
  })

  it('rejects an unknown projectId (validate-before-dispatch)', async () => {
    const skill = makeSkill('inline body 2')
    await expect(triggerSkill(skill.id, 'manual', { projectId: uuid() })).rejects.toThrow(/Project not found/)
  })
})

describe('POST /api/skills/:id/trigger — projectId body validation', () => {
  it('404 when projectId names an unknown project (no dispatch)', async () => {
    const skill = makeSkill('route inline')
    const res = await app.inject({
      method: 'POST', url: `/api/skills/${skill.id}/trigger`, headers: AUTH,
      payload: { projectId: uuid() },
    })
    expect(res.statusCode).toBe(404)
  })

  it('400 when projectId is an empty string', async () => {
    const skill = makeSkill('route inline 2')
    const res = await app.inject({
      method: 'POST', url: `/api/skills/${skill.id}/trigger`, headers: AUTH,
      payload: { projectId: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('202 for a valid projectId', async () => {
    const skill = makeSkill('route inline 3')
    const res = await app.inject({
      method: 'POST', url: `/api/skills/${skill.id}/trigger`, headers: AUTH,
      payload: { projectId: PROJECT_ID },
    })
    expect(res.statusCode).toBe(202)
    expect(typeof res.json().runId).toBe('string')
  })

  it('202 with no body (runs against K, unchanged)', async () => {
    const skill = makeSkill('route inline 4')
    const res = await app.inject({ method: 'POST', url: `/api/skills/${skill.id}/trigger`, headers: AUTH })
    expect(res.statusCode).toBe(202)
  })
})
