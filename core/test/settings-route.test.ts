/**
 * Wave D2 — Settings routes: /api/status + the guarded system-prompt editor.
 *
 * Registers settingsRoutes on a bare Fastify app (like artifacts-route.test) so
 * no bootstrap/socket/poller runs. The system-prompt target is redirected to a
 * temp file via SYSTEM_PROMPT_PATH so the REAL repo CLAUDE.md is never touched.
 * Status shape is asserted via the PURE builder (buildStatus) with fake probes so
 * it is deterministic regardless of whether claude/gh exist in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import {
  settingsRoutes,
  buildStatus,
  splitSystemPrompt,
  composeSystemPrompt,
  GITNEXUS_START,
  GITNEXUS_END,
  type StatusProbes,
  type StatusEnv,
} from '../src/routes/settings.js'

let tmpDir: string
let promptFile: string
const backupDir = path.join(process.env.K_DATA_DIR ?? os.tmpdir(), 'system-prompt-backups')

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'k-settings-test-'))
  promptFile = path.join(tmpDir, 'CLAUDE.md')
  process.env.SYSTEM_PROMPT_PATH = promptFile
})

afterAll(async () => {
  delete process.env.SYSTEM_PROMPT_PATH
  try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function makeApp() {
  const app = Fastify()
  await app.register(settingsRoutes)
  return app
}

// ── Pure builder ───────────────────────────────────────────────────────────────

describe('buildStatus (pure)', () => {
  const env: StatusEnv = {
    ollamaEnabled: true,
    ollamaReachable: false,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    tokenSource: 'generated',
    host: '127.0.0.1',
    terminalEnabled: false,
  }
  const probes: StatusProbes = {
    claude: { available: true, version: '1.2.3' },
    github: { authenticated: true, user: 'octocat' },
  }

  it('shapes the response with all four sections and no secrets', () => {
    const s = buildStatus(probes, env)
    expect(s.claude).toEqual({ available: true, version: '1.2.3' })
    expect(s.ollama).toEqual({
      enabled: true, reachable: false, baseUrl: 'http://localhost:11434', model: 'llama3.2',
    })
    expect(s.github).toEqual({ authenticated: true, user: 'octocat' })
    expect(s.auth.tokenSource).toBe('generated')
    expect(s.auth.loopbackOnly).toBe(true) // derived from 127.0.0.1
    expect(JSON.stringify(s)).not.toMatch(/dev-token|HARNESS_TOKEN/)
  })

  it('marks a non-loopback host as not loopbackOnly', () => {
    const s = buildStatus(probes, { ...env, host: '0.0.0.0' })
    expect(s.auth.loopbackOnly).toBe(false)
  })
})

// ── splitSystemPrompt / composeSystemPrompt (pure) ──────────────────────────────

describe('split/compose system prompt (pure)', () => {
  it('treats the whole file as human when no gitnexus block', () => {
    const { human, block } = splitSystemPrompt('# Hello\n\nbody')
    expect(human).toBe('# Hello\n\nbody')
    expect(block).toBeNull()
  })

  it('extracts the gitnexus block and the human region before it', () => {
    const content = `# Human part\n\n${GITNEXUS_START}\nmanaged\n${GITNEXUS_END}`
    const { human, block } = splitSystemPrompt(content)
    expect(human).toBe('# Human part')
    expect(block).toContain(GITNEXUS_START)
    expect(block).toContain(GITNEXUS_END)
  })

  it('round-trips human + block with a single separator', () => {
    const block = `${GITNEXUS_START}\nmanaged\n${GITNEXUS_END}`
    const composed = composeSystemPrompt('# New human', block)
    const re = splitSystemPrompt(composed)
    expect(re.human).toBe('# New human')
    expect(re.block).toBe(block)
  })
})

// ── /api/status route ──────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  it('returns 200 with the expected top-level keys', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/status' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Object.keys(body).sort()).toEqual(['auth', 'claude', 'github', 'ollama'])
      expect(typeof body.claude.available).toBe('boolean')
      expect(typeof body.ollama.reachable).toBe('boolean')
      expect(typeof body.github.authenticated).toBe('boolean')
      expect(['env', 'generated']).toContain(body.auth.tokenSource)
      // never leak the token value
      expect(JSON.stringify(body)).not.toMatch(/dev-token-change-me/)
    } finally {
      await app.close()
    }
  })
})

// ── /api/system-prompt routes ───────────────────────────────────────────────────

describe('GET/PUT /api/system-prompt', () => {
  it('GET returns the human region only (block stripped)', async () => {
    await fs.writeFile(
      promptFile,
      `# Human guidance\n\nbe nice\n\n${GITNEXUS_START}\ngraph data\n${GITNEXUS_END}\n`,
      'utf8',
    )
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/system-prompt' })
      expect(res.statusCode).toBe(200)
      expect(res.json().md).toBe('# Human guidance\n\nbe nice')
      expect(res.json().md).not.toContain(GITNEXUS_START)
    } finally {
      await app.close()
    }
  })

  it('PUT round-trips the human md', async () => {
    await fs.writeFile(promptFile, '# old\n', 'utf8')
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: '# brand new prompt' },
      })
      expect(put.statusCode).toBe(200)
      expect(typeof put.json().savedAt).toBe('number')

      const get = await app.inject({ method: 'GET', url: '/api/system-prompt' })
      expect(get.json().md).toBe('# brand new prompt')
    } finally {
      await app.close()
    }
  })

  it('preserves an existing gitnexus block across a PUT', async () => {
    const block = `${GITNEXUS_START}\nmanaged graph block\n${GITNEXUS_END}`
    await fs.writeFile(promptFile, `# original human\n\n${block}\n`, 'utf8')
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: '# edited human region' },
      })
      expect(put.statusCode).toBe(200)

      const raw = await fs.readFile(promptFile, 'utf8')
      expect(raw).toContain('# edited human region')
      expect(raw).toContain(GITNEXUS_START)
      expect(raw).toContain('managed graph block')
      expect(raw).toContain(GITNEXUS_END)
      // the block must still be intact/contiguous at the end
      expect(splitSystemPrompt(raw).block).toBe(block)
      // and GET still hides it
      const get = await app.inject({ method: 'GET', url: '/api/system-prompt' })
      expect(get.json().md).toBe('# edited human region')
    } finally {
      await app.close()
    }
  })

  it('writes a backup file on save', async () => {
    await fs.writeFile(promptFile, '# to-be-backed-up\n', 'utf8')
    const before = await listBackups()
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: '# next' },
      })
      expect(put.statusCode).toBe(200)
    } finally {
      await app.close()
    }
    const after = await listBackups()
    expect(after.length).toBeGreaterThan(before.length)
    // the newest backup contains the prior content
    const newest = after.filter(f => !before.includes(f)).sort().pop()!
    const content = await fs.readFile(path.join(backupDir, newest), 'utf8')
    expect(content).toContain('# to-be-backed-up')
  })

  it('rejects an extra key with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: 'ok', evil: true },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects an oversize md with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: 'x'.repeat(200_001) },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects an md containing a gitnexus marker with 400', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system-prompt',
        payload: { md: `# hi\n\n${GITNEXUS_START}\nsneaky\n${GITNEXUS_END}` },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

async function listBackups(): Promise<string[]> {
  try {
    return await fs.readdir(backupDir)
  } catch {
    return []
  }
}
