/**
 * A2 — GitHub poller degrade on a vanished localPath + the derived
 * Project.pathMissing field.
 *
 * Previously a project row whose localPath no longer existed on disk made the
 * poller spam `poll failed ... ENOENT` every 60s forever. Now rowToProject
 * derives pathMissing at read time (never persisted) and pollOnce skips such
 * projects with ONE warn per boot, never touching the row.
 *
 * pollOnce is driven via __pollOnce with an injected fetcher (model:
 * github-poller.test.ts); the route half builds the real app in-process and
 * injects (model: tasks-route.test.ts — K_SKIP_BOOTSTRAP before importing
 * index, supervisor mocked so nothing spawns).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import path from 'path'
import os from 'os'
import { __pollOnce } from '../src/github.js'
import { db, projectsDb } from '../src/db.js'

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance

// Unique remotes so the fetcher-call assertions can't collide with other
// suites' projects living in the shared on-disk DB.
const suffix = uuid().slice(0, 8)
const missingId = uuid()
const missingName = `a2-degrade-missing-${suffix}`
const missingRemote = `a2owner/missing-${suffix}`
const missingPath = path.join(os.tmpdir(), `a2-missing-${uuid()}`) // never created
const controlId = uuid()
const controlName = `a2-degrade-control-${suffix}`
const controlRemote = `a2owner/control-${suffix}`

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  projectsDb.insertProject.run({
    id: missingId, name: missingName, localPath: missingPath,
    githubRemote: missingRemote, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
  projectsDb.insertProject.run({
    id: controlId, name: controlName, localPath: os.tmpdir(), // exists
    githubRemote: controlRemote, workspaceManaged: 0, bibleDir: 'docs/bible', createdAt: Date.now(),
  })
})

afterAll(async () => {
  for (const id of [missingId, controlId]) {
    try { db.prepare('DELETE FROM github_cache WHERE project_id = ?').run(id) } catch { /* ignore */ }
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  await app.close()
})

describe('__pollOnce — missing-localPath projects are skipped, warned once, never mutated', () => {
  it('skips the fetch for the missing project, warns exactly once across two cycles', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    try {
      const calls: Array<{ remote: string; cwd: string }> = []
      const fetcher = async (remote: string, cwd: string) => {
        calls.push({ remote, cwd })
        return { prs: [], ci: [] }
      }

      await __pollOnce(fetcher)
      await __pollOnce(fetcher)

      // never fetched for the missing project; fetched for the control (path exists)
      expect(calls.some(c => c.remote === missingRemote)).toBe(false)
      expect(calls.some(c => c.remote === controlRemote)).toBe(true)

      // exactly ONE warn mentioning the missing project across both cycles —
      // filter by name: other suites' stale projects in the shared DB may also
      // warn once each.
      const mine = warnSpy.mock.calls.filter(args =>
        args.some(a => typeof a === 'string' && a.includes(missingName)),
      )
      expect(mine).toHaveLength(1)

      // the project row is untouched — degrade never deletes or mutates.
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(missingId) as Record<string, unknown>
      expect(row).toBeTruthy()
      expect(row.local_path).toBe(missingPath)
      expect(row.github_remote).toBe(missingRemote)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('GET /api/projects — pathMissing is derived, and only present when true', () => {
  it('missing-path project carries pathMissing: true; healthy project omits the key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const projects = res.json() as Array<Record<string, unknown>>

    const missing = projects.find(p => p.id === missingId)
    const control = projects.find(p => p.id === controlId)
    expect(missing).toBeTruthy()
    expect(control).toBeTruthy()

    expect(missing!.pathMissing).toBe(true)
    // healthy payloads stay byte-identical to before: the key is ABSENT, not false
    expect('pathMissing' in control!).toBe(false)
  })
})
