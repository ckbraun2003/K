/**
 * agent-config.ts — profile-row overrides in the synthesizer (B1).
 *
 * The UI edits agent_profiles.allowed_tools/mcp_servers/skills; before B1 the
 * synthesizer only read the TIER assets, making those editors cosmetic. These
 * tests prove the row now drives synthesis under the fail-closed ceiling rules:
 *   - a NON-EMPTY profile array is the operator's narrowed grant (mounted/granted
 *     exactly, nothing else),
 *   - an EMPTY array means "no override → the tier asset",
 *   - anything OUTSIDE the tier ceiling (allowlist / mcp template / bundle) throws,
 *   - mounting ≠ granting (D-034) still holds against the FINAL allowlist.
 *
 * Mirrors agent-config.test.ts's fixture idioms: each synthesis gets its own temp
 * dataDir; ANTHROPIC_API_KEY is pinned in beforeEach so no host-credential copy
 * ever happens; temp dirs are removed in afterAll.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesizeConfigDir } from '../src/agent-config.js'
import type { AgentProfile } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

const tmpDirs: string[] = []

/** A hand-built orchestrator profile; overrides model the operator's row edits. */
function profileWith(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'b1-profile-test',
    name: 'b1-profile-test',
    tier: 'orchestrator',
    charter: 'orchestrator',
    defaultModel: null,
    allowedTools: [],
    mcpServers: [],
    skills: [],
    ...overrides,
  }
}

/** Synthesize `profile` into a fresh temp dataDir. */
function synthProfile(profile: AgentProfile) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-agcfg-prof-'))
  tmpDirs.push(dataDir)
  const runId = 'run-' + Math.random().toString(36).slice(2)
  return synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
}

const skillDirNames = (configDir: string): string[] => {
  const root = path.join(configDir, 'skills')
  return fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : []
}

const ORIG_API = process.env.ANTHROPIC_API_KEY
const ORIG_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeEach(() => {
  // Pin a K token so synthesis resolves auth via the token path and never copies
  // a dogfooding machine's real host credentials.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})

afterEach(() => {
  if (ORIG_API === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIG_API
  if (ORIG_OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_OAUTH
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('synthesizeConfigDir — profile-row narrowing (B1)', () => {
  it('honors a narrowed row: exact allowlist, only the named MCP server, only the named skill', () => {
    const cfg = synthProfile(
      profileWith({
        allowedTools: ['Read', 'Grep', 'mcp__kstore'],
        mcpServers: ['kstore'],
        skills: ['search-first'],
      }),
    )
    // The narrowed allowlist is passed through EXACTLY (no tier re-widening).
    expect(cfg.allowedTools).toEqual(['Read', 'Grep', 'mcp__kstore'])
    // The written mcp.json mounts ONLY kstore — gitnexus is filtered out.
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(mcp.mcpServers.kstore).toBeDefined()
    expect(mcp.mcpServers.gitnexus).toBeUndefined()
    // Skills: only the named one; the rest of the orchestrator bundle is absent.
    const skills = skillDirNames(cfg.configDir)
    expect(skills).toEqual(['search-first'])
    expect(skills).not.toContain('gitnexus')
    expect(skills).not.toContain('test-driven-development')
  })

  it('tier fallback: empty arrays mean "no override → the tier assets"', () => {
    const cfg = synthProfile(profileWith())
    // allowedTools = the on-disk orchestrator allowlist, verbatim.
    const asset = JSON.parse(
      fs.readFileSync(path.join(ASSET_DIR, 'allowlists', 'orchestrator.json'), 'utf8'),
    ) as { allowedTools: string[] }
    expect(cfg.allowedTools).toEqual(asset.allowedTools)
    // mcp.json mounts the full tier server set.
    const mcp = JSON.parse(fs.readFileSync(cfg.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(mcp.mcpServers.gitnexus).toBeDefined()
    expect(mcp.mcpServers.kstore).toBeDefined()
    // skills/ = the full orchestrator bundle set.
    const bundle = JSON.parse(
      fs.readFileSync(path.join(ASSET_DIR, 'bundles', 'orchestrator.json'), 'utf8'),
    ) as { skills: string[] }
    expect(skillDirNames(cfg.configDir)).toEqual([...bundle.skills].sort())
  })

  it('rejects an above-tier grant at synth time (the dead Agent token)', () => {
    expect(() => synthProfile(profileWith({ allowedTools: ['Bash', 'Agent'] }))).toThrow(
      /exceeds the .* tier ceiling/,
    )
  })

  it('rejects a profile MCP server the tier template does not define (fail-closed)', () => {
    expect(() =>
      synthProfile(
        profileWith({
          mcpServers: ['kstore', 'ghost'],
          allowedTools: ['mcp__ghost', 'mcp__kstore'],
        }),
      ),
    ).toThrow(/defines no such server/)
  })

  it('rejects a profile skill outside the tier bundle (the bundle is the ceiling)', () => {
    expect(() => synthProfile(profileWith({ skills: ['definitely-not-a-skill'] }))).toThrow(
      /tier bundle is the ceiling/,
    )
  })

  it('mounting ≠ granting is preserved at synth time (D-034)', () => {
    // kstore is mounted by the row but the narrowed allowlist grants no mcp__kstore.
    expect(() =>
      synthProfile(profileWith({ mcpServers: ['kstore'], allowedTools: ['Read'] })),
    ).toThrow(/does not grant it/)
  })
})
