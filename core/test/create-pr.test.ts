/**
 * G-6 — createPR function + POST /api/projects/:id/prs route tests.
 *
 * The `gh` CLI is not available in CI, so `execa` is mocked at the module level
 * for unit tests of `createPR`, and `createPR` itself is stubbed at the route
 * level for integration tests of the HTTP endpoint.
 *
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { db, projectsDb } from '../src/db.js'

// ── createPR unit tests (execa mocked) ────────────────────────────────────────

// Must mock before importing the module under test
const mockExeca = vi.fn()

vi.mock('execa', () => ({
  execa: mockExeca,
}))

describe('createPR — unit (execa mocked)', () => {
  beforeAll(async () => {
    // Ensure the mock is reset before each suite
    mockExeca.mockReset()
  })

  it('happy path: parses the gh JSON output and returns PR fields', async () => {
    const prPayload = { number: 42, url: 'https://github.com/foo/bar/pull/42', title: 'feat: test', state: 'open' }
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify(prPayload),
      stderr: '',
    })

    const { createPR } = await import('../src/github.js')
    const result = await createPR('foo/bar', {
      title: 'feat: test',
      body: '',
      head: 'feat/test',
      base: 'main',
    })

    expect(result).toEqual(prPayload)
  })

  it('execa is called with an argv array (not a shell string) — command injection guard', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 1, url: 'u', title: 't', state: 'open' }),
      stderr: '',
    })

    const { createPR } = await import('../src/github.js')
    await createPR('owner/repo', {
      title: 'test',
      body: 'body',
      head: 'feat/x',
      base: 'main',
    })

    // Verify execa was called with a command string and an array as the second arg
    expect(mockExeca).toHaveBeenCalled()
    const [_binary, args] = mockExeca.mock.calls[mockExeca.mock.calls.length - 1] as [string, string[], unknown]
    expect(Array.isArray(args)).toBe(true)
    // The title should appear as a discrete array element, not shell-interpolated
    expect(args).toContain('test')
  })

  it('non-JSON stdout: throws a descriptive error (not SyntaxError)', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'not-json-output',
      stderr: '',
    })

    const { createPR } = await import('../src/github.js')
    await expect(
      createPR('foo/bar', { title: 'x', body: '', head: 'feat/x', base: 'main' })
    ).rejects.toThrow(/gh pr create returned unexpected output/)
  })

  it('execa throws: throws a sanitized error (no raw stderr dump)', async () => {
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error('execa error'), {
        stderr: 'error: authentication required\nhttps://github.com/login/oauth/authorize?...',
        exitCode: 1,
      })
    )

    const { createPR } = await import('../src/github.js')
    const err = await createPR('foo/bar', { title: 'x', body: '', head: 'feat/x', base: 'main' })
      .then(() => null)
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    // Should not include raw URLs in the sanitized message
    expect((err as Error).message).not.toContain('https://')
    // Should be a concise message
    expect((err as Error).message.length).toBeLessThan(200)
  })
})

// ── POST /api/projects/:id/prs route tests ────────────────────────────────────

vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

const TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let app: FastifyInstance
let projectIdWithRemote: string
let projectIdWithoutRemote: string

beforeAll(async () => {
  process.env.K_SKIP_BOOTSTRAP = '1'
  const { buildApp } = await import('../src/index.js')
  app = await buildApp()
  await app.ready()

  projectIdWithRemote = uuid()
  projectsDb.insertProject.run({
    id: projectIdWithRemote,
    name: `create-pr-test-remote-${projectIdWithRemote.slice(0, 8)}`,
    localPath: '/tmp/create-pr-test-remote',
    githubRemote: 'owner/repo',
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })

  projectIdWithoutRemote = uuid()
  projectsDb.insertProject.run({
    id: projectIdWithoutRemote,
    name: `create-pr-test-no-remote-${projectIdWithoutRemote.slice(0, 8)}`,
    localPath: '/tmp/create-pr-test-no-remote',
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
})

afterAll(async () => {
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectIdWithRemote) } catch { /* ignore */ }
  try { db.prepare('DELETE FROM projects WHERE id = ?').run(projectIdWithoutRemote) } catch { /* ignore */ }
  await app.close()
})

describe('POST /api/projects/:id/prs', () => {
  it('400 if project has no githubRemote', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectIdWithoutRemote}/prs`,
      headers: AUTH,
      payload: { title: 'feat: test', body: '', head: 'feat/test', base: 'main' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/remote/i)
  })

  it('400 on missing title (schema validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectIdWithRemote}/prs`,
      headers: AUTH,
      payload: { body: 'no title here', head: 'feat/x', base: 'main' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400 on empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectIdWithRemote}/prs`,
      headers: AUTH,
      payload: { title: '', body: '', head: 'feat/x', base: 'main' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('201 on success (createPR stubbed via execa mock)', async () => {
    // execa mock is already set up from the unit tests above; reset and set success response
    mockExeca.mockReset()
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 99, url: 'https://github.com/owner/repo/pull/99', title: 'feat: my pr', state: 'open' }),
      stderr: '',
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectIdWithRemote}/prs`,
      headers: AUTH,
      payload: { title: 'feat: my pr', body: 'details', head: 'feat/x', base: 'main' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { number: number; url: string; title: string; state: string }
    expect(body.number).toBe(99)
    expect(body.url).toContain('github.com')
  })

  it('404 for unknown project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${uuid()}/prs`,
      headers: AUTH,
      payload: { title: 'feat: test', body: '', head: 'feat/test', base: 'main' },
    })
    expect(res.statusCode).toBe(404)
  })
})
