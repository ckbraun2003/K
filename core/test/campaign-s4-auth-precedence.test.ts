/**
 * Campaign S4 — auth resolution precedence (LOCK suite).
 *
 * Pointing CLAUDE_CONFIG_DIR at the run dir replaces the ENTIRE host ~/.claude
 * layer — INCLUDING credentials — so synthesizeConfigDir must resolve auth. The
 * design (agent-config.ts docblock): a K-supplied token is PREFERRED
 * (ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN), with a guarded host-credential
 * copy as a dogfooding fallback, else unauthenticated with a warning. The existing
 * suite tests only the API-key path and the bare fallback; these pin the rest of
 * the precedence ladder and its no-leak guarantees:
 *   - API key beats OAuth when both are set,
 *   - OAuth-only resolves to the OAuth env, no fallback,
 *   - a token present means the host credentials file is NEVER copied (no leak),
 *   - no token + no host file → unauthenticated, warns, copies nothing,
 *   - an empty-string token is treated as unset (falls through).
 *
 * Findings: S4-010..S4-014. See testing/findings/S4-prompt-delegation.md.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  synthesizeConfigDir,
  credentialPosture,
  hostCredentialFallbackDisabled,
} from '../src/agent-config.js'
import { DEFAULT_PROFILE } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const tmpDirs: string[] = []

function freshDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-auth-'))
  tmpDirs.push(d)
  return d
}
function synth(opts: { hostCredentialsPath?: string } = {}) {
  const dataDir = freshDataDir()
  const runId = 'run-' + Math.random().toString(36).slice(2)
  return synthesizeConfigDir(DEFAULT_PROFILE, { runId, dataDir, assetsDir: ASSET_DIR, ...opts })
}
/** Write a host-credentials fixture file that EXISTS for fallback/leak probes. */
function hostCredFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-hostcred-'))
  tmpDirs.push(dir)
  const p = path.join(dir, '.credentials.json')
  fs.writeFileSync(p, JSON.stringify({ token: 'host-secret-DO-NOT-COPY' }), 'utf8')
  return p
}
const copiedCredPath = (configDir: string) => path.join(configDir, '.credentials.json')

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN
const ORIG_DISABLE = process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK
})
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
  if (ORIG_DISABLE === undefined) delete process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK
  else process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK = ORIG_DISABLE
  vi.restoreAllMocks()
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('S4 auth precedence: token ladder', () => {
  it('S4-010: ANTHROPIC_API_KEY beats CLAUDE_CODE_OAUTH_TOKEN when BOTH are set', () => {
    process.env.ANTHROPIC_API_KEY = 'api-key-wins'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-loses'
    const cfg = synth()
    expect(cfg.authEnv).toEqual({ ANTHROPIC_API_KEY: 'api-key-wins' })
    expect(cfg.authEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
  })

  it('S4-011: OAuth-only resolves to the OAuth env — no host fallback, no copy', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-only'
    const host = hostCredFixture()
    const cfg = synth({ hostCredentialsPath: host })
    expect(cfg.authEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-only' })
    expect(cfg.usedHostCredentialFallback).toBe(false)
    // a token is present, so the host file is NOT copied even though it exists.
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
  })

  it('S4-014: an empty-string ANTHROPIC_API_KEY is treated as UNSET (falls through to OAuth)', () => {
    process.env.ANTHROPIC_API_KEY = ''
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fallthrough'
    const cfg = synth()
    expect(cfg.authEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fallthrough' })
  })
})

describe('S4 auth precedence: no-leak + unauthenticated', () => {
  it('S4-012: a token present means the host credentials file is NEVER copied (no leak)', () => {
    process.env.ANTHROPIC_API_KEY = 'token-present'
    const host = hostCredFixture()
    const cfg = synth({ hostCredentialsPath: host })
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
    // the host secret never appears in any written config file
    for (const name of ['system-prompt.md', 'settings.json', 'mcp.json']) {
      const body = fs.readFileSync(path.join(cfg.configDir, name), 'utf8')
      expect(body).not.toContain('host-secret-DO-NOT-COPY')
    }
  })

  it('S4-013: no token + no host credentials file → unauthenticated, warns, copies nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingHost = path.join(freshDataDir(), 'does-not-exist', '.credentials.json')
    const cfg = synth({ hostCredentialsPath: missingHost })
    expect(cfg.authEnv).toEqual({})
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
    expect(warn).toHaveBeenCalled()
    const msg = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(msg).toMatch(/unauthenticated/i)
  })
})

// ── F-064/F-090: host-credential fallback opt-out + posture ──────────────────────
describe('host-credential fallback opt-out (K_DISABLE_HOST_CREDENTIAL_FALLBACK)', () => {
  it('DEFAULT (flag unset): fallback still copies host creds — OOTB behaviour unchanged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = hostCredFixture()
    const cfg = synth({ hostCredentialsPath: host })
    expect(cfg.usedHostCredentialFallback).toBe(true)
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(true)
  })

  it('flag SET: refuses to copy host creds, fails closed to unauthenticated, warns actionably', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK = 'true'
    const host = hostCredFixture()
    const cfg = synth({ hostCredentialsPath: host })
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(cfg.authEnv).toEqual({})
    // the host credentials file (which EXISTS) is NOT copied
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
    const msg = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(msg).toMatch(/K_DISABLE_HOST_CREDENTIAL_FALLBACK/)
    expect(msg).toMatch(/UNAUTHENTICATED/)
  })

  it('flag SET but a managed token present → managed path wins (no copy, no opt-out warn)', () => {
    process.env.K_DISABLE_HOST_CREDENTIAL_FALLBACK = 'true'
    process.env.ANTHROPIC_API_KEY = 'managed-wins'
    const host = hostCredFixture()
    const cfg = synth({ hostCredentialsPath: host })
    expect(cfg.authEnv).toEqual({ ANTHROPIC_API_KEY: 'managed-wins' })
    expect(cfg.usedHostCredentialFallback).toBe(false)
    expect(fs.existsSync(copiedCredPath(cfg.configDir))).toBe(false)
  })
})

describe('hostCredentialFallbackDisabled (pure)', () => {
  it('default (unset/empty) → false; truthy values → true; other strings → false', () => {
    expect(hostCredentialFallbackDisabled({})).toBe(false)
    expect(hostCredentialFallbackDisabled({ K_DISABLE_HOST_CREDENTIAL_FALLBACK: '' })).toBe(false)
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' On ']) {
      expect(hostCredentialFallbackDisabled({ K_DISABLE_HOST_CREDENTIAL_FALLBACK: v }), v).toBe(true)
    }
    expect(hostCredentialFallbackDisabled({ K_DISABLE_HOST_CREDENTIAL_FALLBACK: 'false' })).toBe(false)
    expect(hostCredentialFallbackDisabled({ K_DISABLE_HOST_CREDENTIAL_FALLBACK: 'nope' })).toBe(false)
  })
})

describe('credentialPosture (pure, no secret)', () => {
  it('managed when a managed token is set (either kind)', () => {
    expect(credentialPosture({ ANTHROPIC_API_KEY: 'x' })).toBe('managed')
    expect(credentialPosture({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe('managed')
    // managed wins even if the opt-out flag is also set
    expect(credentialPosture({ ANTHROPIC_API_KEY: 'x', K_DISABLE_HOST_CREDENTIAL_FALLBACK: 'true' })).toBe('managed')
  })
  it('host-fallback by default when no managed token', () => {
    expect(credentialPosture({})).toBe('host-fallback')
    expect(credentialPosture({ ANTHROPIC_API_KEY: '' })).toBe('host-fallback')
  })
  it('disabled when no managed token and the fallback is opted out', () => {
    expect(credentialPosture({ K_DISABLE_HOST_CREDENTIAL_FALLBACK: 'true' })).toBe('disabled')
  })
  it('never returns a credential value', () => {
    const p = credentialPosture({ ANTHROPIC_API_KEY: 'super-secret' })
    expect(p).toBe('managed')
    expect(p).not.toContain('secret')
  })
})
