/**
 * L1.5 identity overlays (Continuous Agents C.2, D-126).
 *
 * A profile's `identityOverlay` is appended VERBATIM between the L1 role template
 * and L2 at synthesis when non-empty (same `---` joiner as L0/L1); null/absent/''/
 * whitespace-only leaves synthesis BYTE-IDENTICAL to the pre-overlay output (the
 * regression lock the neighbor byte-lock suites depend on). Persistence follows
 * the defaultModel absent-vs-null convention (absent keeps, null clears), and
 * seedProfiles() stamps the chief + five lead seed overlays NULL-only — an
 * operator edit, including blanking to '', survives every re-seed.
 *
 * Mirrors run-assets-shim.test.ts fixture idioms: hand-built profiles, temp
 * dataDirs, ANTHROPIC_API_KEY pinned so synthesis never copies host credentials.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { AgentProfile } from '@k/shared'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { createProfile, updateProfile, getProfile, seedProfiles } from '../src/profiles.js'
import { db } from '../src/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const l0 = () => fs.readFileSync(path.join(ASSET_DIR, 'base-operating-prompt.md'), 'utf8')
const l1 = (charter: string) =>
  fs.readFileSync(path.join(ASSET_DIR, 'tiers', `${charter}.charter.md`), 'utf8')

const tmpDirs: string[] = []
const createdProfiles: string[] = []

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeEach(() => {
  // Pin a K token so synthesis resolves auth via the token path and never copies
  // a dogfooding machine's real host credentials (run-assets-shim convention).
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  for (const id of createdProfiles) db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id)
})

function profileWith(overlay: string | null | undefined): AgentProfile {
  // Hand-built orchestrator profile, the run-assets-shim profileWith() field set:
  // empty authority arrays = "no override → tier assets".
  return {
    id: `p51-c2-${randomUUID().slice(0, 8)}`, name: 'p51-c2', tier: 'orchestrator',
    charter: 'orchestrator', defaultModel: null, allowedTools: [], mcpServers: [], skills: [],
    ...(overlay !== undefined ? { identityOverlay: overlay } : {}),
  }
}

function synth(profile: AgentProfile): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-c2-'))
  tmpDirs.push(dataDir)
  const cfg = synthesizeConfigDir(profile, { runId: randomUUID(), dataDir, assetsDir: ASSET_DIR })
  return fs.readFileSync(cfg.appendSystemPromptFile, 'utf8')
}

describe('L1.5 identity overlay — synthesis (C.2)', () => {
  it('REGRESSION-LOCK: null / absent / empty / whitespace overlay ⇒ byte-identical L0+L1 output', () => {
    const expected = `${l0()}\n\n---\n\n${l1('orchestrator')}`
    expect(synth(profileWith(null))).toBe(expected)
    expect(synth(profileWith(undefined))).toBe(expected)
    expect(synth(profileWith(''))).toBe(expected)
    expect(synth(profileWith('  \n \t '))).toBe(expected)
  })

  it('non-empty overlay appends VERBATIM after L1 with the same joiner', () => {
    const overlay = '## Identity: test\n\nA overlay body — kept verbatim, untrimmed.  '
    expect(synth(profileWith(overlay)))
      .toBe(`${l0()}\n\n---\n\n${l1('orchestrator')}\n\n---\n\n${overlay}`)
  })

  it('chief-tier synthesis layers the overlay over the manager role template', () => {
    const overlay = '## Identity: Probe Manager'
    const p: AgentProfile = { ...profileWith(overlay), tier: 'chief', charter: 'chief' }
    expect(synth(p)).toBe(`${l0()}\n\n---\n\n${l1('chief')}\n\n---\n\n${overlay}`)
  })
})

describe('identity overlay — persistence (C.2)', () => {
  it('createProfile persists the overlay; getProfile round-trips it', () => {
    const p = createProfile({ name: `p51-c2-${randomUUID().slice(0, 8)}`, tier: 'orchestrator', identityOverlay: 'seeded overlay' })
    createdProfiles.push(p.id)
    expect(getProfile(p.id)?.identityOverlay).toBe('seeded overlay')
  })
  it('updateProfile: absent keeps, explicit null clears, string replaces', () => {
    const p = createProfile({ name: `p51-c2-${randomUUID().slice(0, 8)}`, tier: 'orchestrator', identityOverlay: 'v1' })
    createdProfiles.push(p.id)
    expect(updateProfile(p.id, { defaultModel: null })?.identityOverlay).toBe('v1')
    expect(updateProfile(p.id, { identityOverlay: 'v2' })?.identityOverlay).toBe('v2')
    // '' persists as '' through the app-layer write (NOT coerced to null) — the
    // operator's "silence the seed" value survives the full round trip.
    expect(updateProfile(p.id, { identityOverlay: '' })?.identityOverlay).toBe('')
    expect(updateProfile(p.id, { identityOverlay: null })?.identityOverlay).toBeNull()
  })
})

describe('identity overlay — seeds (C.2)', () => {
  it('seedProfiles stamps chief + five lead overlays where NULL; operator edits survive', () => {
    seedProfiles()
    for (const id of ['chief', 'lead-frontend', 'lead-backend', 'lead-systems', 'lead-security', 'lead-network']) {
      const o = getProfile(id)?.identityOverlay
      expect(o, `${id} has a seeded overlay`).toBeTruthy()
    }
    // operator edit survives a re-seed; blank-to-'' ALSO survives ('' ≠ NULL — the
    // documented silencing affordance, mirroring the domain-stamp NULL-only posture)
    try {
      db.prepare(`UPDATE agent_profiles SET identity_overlay = 'custom' WHERE id = 'lead-frontend'`).run()
      db.prepare(`UPDATE agent_profiles SET identity_overlay = '' WHERE id = 'lead-backend'`).run()
      seedProfiles()
      expect(getProfile('lead-frontend')?.identityOverlay).toBe('custom')
      expect(getProfile('lead-backend')?.identityOverlay).toBe('')
    } finally {
      // restore the seeds for other suites — in finally so a mid-test assertion
      // failure can never leave 'custom'/'' stuck in the shared test DB (the
      // NULL-only stamp would never repair '' on later runs)
      db.prepare(`UPDATE agent_profiles SET identity_overlay = NULL WHERE id IN ('lead-frontend','lead-backend')`).run()
      seedProfiles()
    }
  })
})
