/**
 * Campaign S4 — MCP config synthesis (LOCK suite).
 *
 * synthesizeConfigDir copies the tier's mcp/<charter>.json and REWRITES the
 * kstore server to THIS core's k-store-server launch with the run's
 * K_DATA_DIR / K_RUN_ID injected. The existing agent-config test pins the
 * orchestrator kstore rewrite shape; these tests pin the SYNTHESIS angles it
 * does not:
 *   - the per-tier server SET (secretary mounts ONLY kstore — no gitnexus;
 *     chief + orchestrator mount BOTH),
 *   - the kstore K_DATA_DIR follows the dataDir resolution chain, including the
 *     process.env.K_DATA_DIR fallback when opts.dataDir is omitted,
 *   - re-synthesizing the SAME runId is idempotent (mcp.json byte-identical).
 *
 * Findings: S4-005 (per-tier server set), S4-006 (kstore env + dataDir fallback),
 * S4-007 (idempotent re-synth). See testing/findings/S4-prompt-delegation.md.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-s4-mcp-'))
  tmpDirs.push(d)
  return d
}
function synthAs(charterTier: CharterName, opts: { dataDir?: string; runId?: string } = {}) {
  const dataDir = opts.dataDir ?? freshDataDir()
  const runId = opts.runId ?? 'run-' + Math.random().toString(36).slice(2)
  const profile = { ...DEFAULT_PROFILE, tier: charterTier, charter: charterTier }
  const cfg = synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
  return { cfg, dataDir, runId }
}
function readMcp(cfg: { mcpConfigPath: string }) {
  return JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
  }
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN
const ORIG_KDD = process.env.K_DATA_DIR

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
  // Always restore K_DATA_DIR (one test mutates it to probe the fallback).
  if (ORIG_KDD === undefined) delete process.env.K_DATA_DIR
  else process.env.K_DATA_DIR = ORIG_KDD
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('S4 mcp synthesis: per-tier server set', () => {
  it('S4-005: secretary mounts ONLY kstore (no gitnexus)', () => {
    const { cfg } = synthAs('secretary')
    const servers = Object.keys(readMcp(cfg).mcpServers).sort()
    expect(servers).toEqual(['kstore'])
  })

  it('S4-005: chief and orchestrator each mount BOTH gitnexus + kstore', () => {
    for (const tier of ['chief', 'orchestrator'] as CharterName[]) {
      const { cfg } = synthAs(tier)
      const servers = Object.keys(readMcp(cfg).mcpServers).sort()
      expect(servers, `${tier} servers`).toEqual(['gitnexus', 'kstore'])
      // gitnexus passes through as the portable npx stdio server, untouched.
      expect(readMcp(cfg).mcpServers.gitnexus.command).toBe('npx')
    }
  })
})

describe('S4 mcp synthesis: kstore binding + dataDir resolution', () => {
  it('S4-006: every tier binds kstore to this run (K_DATA_DIR=opts.dataDir, K_RUN_ID=runId, no placeholders)', () => {
    for (const tier of ['orchestrator', 'chief', 'secretary'] as CharterName[]) {
      const { cfg, dataDir, runId } = synthAs(tier)
      const k = readMcp(cfg).mcpServers.kstore
      expect(k.command, `${tier} command`).toBe(process.execPath)
      expect(k.env?.K_DATA_DIR, `${tier} K_DATA_DIR`).toBe(dataDir)
      expect(k.env?.K_RUN_ID, `${tier} K_RUN_ID`).toBe(runId)
      // no leftover placeholders anywhere in the resolved server config
      const blob = JSON.stringify(readMcp(cfg).mcpServers)
      expect(blob).not.toContain('__KSTORE__')
      expect(blob).not.toContain('__K_DATA_DIR__')
      expect(blob).not.toContain('__K_RUN_ID__')
    }
  })

  it('S4-006: when opts.dataDir is omitted, kstore K_DATA_DIR falls back to process.env.K_DATA_DIR', () => {
    // Drive the documented resolution chain: opts.dataDir ?? process.env.K_DATA_DIR ?? <repo>/data.
    const envDataDir = freshDataDir()
    process.env.K_DATA_DIR = envDataDir
    const runId = 'run-' + Math.random().toString(36).slice(2)
    const cfg = synthesizeConfigDir(
      { ...DEFAULT_PROFILE },
      { runId, assetsDir: ASSET_DIR }, // no dataDir → must use process.env.K_DATA_DIR
    )
    const k = readMcp(cfg).mcpServers.kstore
    expect(k.env?.K_DATA_DIR).toBe(envDataDir)
    // and the config dir itself was materialized under that fallback dataDir
    expect(cfg.configDir.startsWith(envDataDir)).toBe(true)
    cfg.cleanup()
  })
})

describe('S4 mcp synthesis: idempotent re-synth', () => {
  it('S4-007: re-synthesizing the SAME runId yields a byte-identical mcp.json', () => {
    const dataDir = freshDataDir()
    const runId = 'run-fixed-idem'
    const first = synthAs('orchestrator', { dataDir, runId }).cfg
    const a = fs.readFileSync(first.mcpConfigPath, 'utf8')
    const second = synthAs('orchestrator', { dataDir, runId }).cfg
    const b = fs.readFileSync(second.mcpConfigPath, 'utf8')
    expect(second.mcpConfigPath).toBe(first.mcpConfigPath)
    expect(b).toBe(a)
  })
})
