/**
 * Campaign S4 — system-prompt layering L0 → L1 (LOCK suite).
 *
 * synthesizeConfigDir writes ONE system-prompt.md = the L0 base operating prompt
 * + a `---` separator + the L1 tier charter (no config-dir CLAUDE.md, to avoid
 * double injection). The L2 task layer is the delegation prompt, supplied
 * separately to startRun (covered by the delegation-determinism suite). These
 * tests pin the layering CONTRACT the existing suite does not:
 *   - the file is L0 THEN separator THEN L1 (ordering, not just "both present"),
 *   - the L1 charter materialized matches the requested tier (and not another),
 *   - a MISSING base prompt or charter makes synthesis FAIL LOUDLY (it never
 *     silently ships a half-built system prompt).
 *
 * Note (latent risk, documented in the findings, no separate test): synthesis
 * does NOT independently validate L0/L1 non-emptiness — it trusts the Wave-1
 * asset validator. An EMPTY (but present) base prompt would be silently shipped
 * as a degraded prompt. Unreachable with the shipped, validated assets.
 *
 * Findings: S4-008 (layer order + per-tier charter), S4-009 (missing asset
 * throws). See testing/findings/S4-prompt-delegation.md.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { DEFAULT_PROFILE, type CharterName } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const tmpDirs: string[] = []

function freshDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-prompt-'))
  tmpDirs.push(d)
  return d
}
function synthAs(charterTier: CharterName) {
  const dataDir = freshDataDir()
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const profile = { ...DEFAULT_PROFILE, tier: charterTier, charter: charterTier }
  return synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
}

const L0_MARKER = 'You are an agent run by'
// A distinguishing L1 marker per tier (from agent-config/tiers/<tier>.charter.md).
const L1_MARKER: Record<CharterName, string> = {
  orchestrator: '# Orchestrator Charter',
  chief: '# Chief Charter',
  secretary: '# Secretary Charter (K)',
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key' })
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('S4 prompt layering: order + per-tier charter', () => {
  it('S4-008: system-prompt.md is L0, then a --- separator, then L1 — in that order', () => {
    const cfg = synthAs('orchestrator')
    const body = fs.readFileSync(cfg.appendSystemPromptFile, 'utf8')
    const i0 = body.indexOf(L0_MARKER)
    const iSep = body.indexOf('\n---\n')
    const i1 = body.indexOf(L1_MARKER.orchestrator)
    expect(i0, 'L0 present').toBeGreaterThanOrEqual(0)
    expect(i1, 'L1 present').toBeGreaterThanOrEqual(0)
    expect(iSep, 'separator present').toBeGreaterThan(i0)
    expect(i1, 'L1 follows the separator').toBeGreaterThan(iSep)
  })

  it('S4-008: the materialized L1 charter matches the requested tier and excludes the others', () => {
    for (const tier of ['orchestrator', 'chief', 'secretary'] as CharterName[]) {
      const cfg = synthAs(tier)
      const body = fs.readFileSync(cfg.appendSystemPromptFile, 'utf8')
      expect(body, `${tier} carries its own charter`).toContain(L1_MARKER[tier])
      for (const other of ['orchestrator', 'chief', 'secretary'] as CharterName[]) {
        if (other === tier) continue
        expect(body, `${tier} must not carry the ${other} charter`).not.toContain(L1_MARKER[other])
      }
      // L0 is always present regardless of tier.
      expect(body).toContain(L0_MARKER)
    }
  })
})

describe('S4 prompt layering: a missing critical asset fails loudly', () => {
  it('S4-009: a missing base-operating-prompt.md throws (no silent half-build)', () => {
    // An assetsDir with NO base prompt: the first asset read (L0) must throw.
    const emptyAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-noassets-'))
    tmpDirs.push(emptyAssets)
    const dataDir = freshDataDir()
    expect(() =>
      synthesizeConfigDir(DEFAULT_PROFILE, { runId: 'run-x', dataDir, assetsDir: emptyAssets }),
    ).toThrow()
  })

  it('S4-009: a present base prompt but a MISSING tier charter throws', () => {
    // base prompt exists, charter does not → the L1 read must throw.
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-nocharter-'))
    tmpDirs.push(assets)
    fs.writeFileSync(path.join(assets, 'base-operating-prompt.md'), 'You are an agent run by K.', 'utf8')
    const dataDir = freshDataDir()
    expect(() =>
      synthesizeConfigDir(DEFAULT_PROFILE, { runId: 'run-y', dataDir, assetsDir: assets }),
    ).toThrow()
  })
})
