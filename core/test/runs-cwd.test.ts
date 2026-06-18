/**
 * A2 regression — unvalidated cwd in POST /api/runs.
 *
 * A client-supplied `cwd` must resolve under a registered project's localPath or
 * under REPO_ROOT; an arbitrary path (C:\Windows, /etc) is rejected with 400.
 * The supervisor is mocked so no claude process is ever spawned — but REPO_ROOT
 * is kept real so the default-cwd allow path is exercised.
 */
import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Mock only startRun; keep the real REPO_ROOT so cwd-under-repo is genuinely allowed.
vi.mock('../src/supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supervisor.js')>('../src/supervisor.js')
  return { ...actual, startRun: vi.fn(async () => ({ id: 'mock-run' })), kill: vi.fn(() => false) }
})

import { runsRoutes } from '../src/routes/runs.js'
import { startRun, REPO_ROOT } from '../src/supervisor.js'
import { projectsDb, db } from '../src/db.js'

const startRunMock = vi.mocked(startRun)
const projectIds: string[] = []
const tmpDirs: string[] = []

function insertProject(localPath: string): string {
  const id = uuid()
  projectsDb.insertProject.run({
    id,
    name: `runs-cwd-${id.slice(0, 8)}`,
    localPath,
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'docs/bible',
    createdAt: Date.now(),
  })
  projectIds.push(id)
  return id
}

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-runs-cwd-'))
  tmpDirs.push(d)
  return d
}

afterAll(() => {
  for (const id of projectIds) {
    try { db.prepare('DELETE FROM projects WHERE id = ?').run(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

async function makeApp() {
  const app = Fastify()
  await app.register(runsRoutes)
  return app
}

describe('POST /api/runs — cwd validation', () => {
  beforeEach(() => startRunMock.mockClear())

  it('rejects a cwd outside any registered project / REPO_ROOT with 400', async () => {
    const app = await makeApp()
    try {
      const evil = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { prompt: 'hi', cwd: evil },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/cwd not under a registered project/)
      expect(startRunMock).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('does not reject on cwd grounds when no cwd is provided', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { prompt: 'hi' } })
      expect(res.statusCode).toBe(201)
      expect(startRunMock).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })

  it('accepts a cwd under a registered project', async () => {
    const dir = makeTmp()
    insertProject(dir)
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { prompt: 'hi', cwd: path.join(dir, 'sub') },
      })
      expect(res.statusCode).toBe(201)
      expect(startRunMock).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })

  it('accepts a cwd under REPO_ROOT', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { prompt: 'hi', cwd: path.join(REPO_ROOT, 'core') },
      })
      expect(res.statusCode).toBe(201)
      expect(startRunMock).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })
})
