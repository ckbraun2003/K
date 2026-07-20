/**
 * authority.ts — tier → { allowedTools, mcpServers, skills } resolver + guards.
 *
 * Proves the control-plane read half over the SHIPPED agent-config assets:
 *   - the coding-tools gating boundary (Bash/Write/Edit/Task at orchestrator ONLY;
 *     none at chief/secretary; the token is `Task`, never `Agent` — D-032);
 *   - the mcp↔allowlist grant invariant (a mounted server MUST be allowlisted —
 *     D-034 "mounting ≠ granting"), both as a direct unit and as the fail-closed
 *     guard resolveAuthority runs over a crafted temp asset dir.
 *
 * Pure filesystem — no DB, no supervisor.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveAuthority,
  assertMcpGrants,
  assertCodingToolsGating,
  CODING_TOOLS,
} from '../src/authority.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('resolveAuthority — per-tier resolution over shipped assets', () => {
  it('orchestrator grants the coding tools + both MCP servers + the skill roster', () => {
    const a = resolveAuthority('orchestrator')
    for (const tool of CODING_TOOLS) expect(a.allowedTools).toContain(tool)
    expect(a.allowedTools).toContain('mcp__gitnexus')
    expect(a.allowedTools).toContain('mcp__kstore')
    expect(a.mcpServers.sort()).toEqual(['gitnexus', 'kstore'])
    expect(a.skills).toContain('gitnexus')
    expect(a.skills).toContain('subagent-driven-development')
  })

  it('secretary grants NO coding tools and mounts kstore + logistics + gitnexus (read)', () => {
    const a = resolveAuthority('secretary')
    for (const tool of CODING_TOOLS) expect(a.allowedTools).not.toContain(tool)
    expect(a.allowedTools).not.toContain('Agent') // the tool-id is `Task`, never `Agent`
    // ca-a A.5 (D-126): the primary agent gains the gitnexus mount (read-only by allowlist).
    expect(a.mcpServers.sort()).toEqual(['gitnexus', 'kstore', 'logistics'])
    // The skills BUNDLE stays lean — code intelligence comes from the MCP server.
    expect(a.skills).not.toContain('gitnexus')
  })

  it('chief grants NO coding tools but mounts gitnexus (read) + kstore + mgmt', () => {
    const a = resolveAuthority('chief')
    for (const tool of CODING_TOOLS) expect(a.allowedTools).not.toContain(tool)
    // P5.2a: the mgmt working store joins gitnexus (read) + kstore on the chief tier.
    expect(a.mcpServers.sort()).toEqual(['gitnexus', 'kstore', 'mgmt'])
    // Mounting ≠ granting (D-034): mgmt must carry an mcp__mgmt grant, and
    // resolveAuthority runs assertMcpGrants — so a clean resolve here proves it.
    expect(a.allowedTools).toContain('mcp__mgmt')
    // chief mounts a planning/read subset (incl. gitnexus) but NO coding agents.
    expect(a.skills).toContain('gitnexus')
    expect(a.skills).toContain('capturing-lessons')
  })

  it('chief still passes the coding-tools gating boundary with mgmt mounted (no coding tool gained)', () => {
    // The whole-foundation invariant: adding mcp__mgmt must not slip a coding tool
    // onto the chief tier. assertCodingToolsGating throws on any violation.
    expect(() => assertCodingToolsGating()).not.toThrow()
    const a = resolveAuthority('chief')
    for (const tool of CODING_TOOLS) expect(a.allowedTools).not.toContain(tool)
  })
})

describe('assertCodingToolsGating — the shipped boundary holds', () => {
  it('does not throw over the shipped assets', () => {
    expect(() => assertCodingToolsGating()).not.toThrow()
  })
})

describe('assertMcpGrants — mounting ≠ granting (D-034)', () => {
  it('passes when every mounted server carries an mcp__<server> grant', () => {
    expect(() => assertMcpGrants('orchestrator', ['mcp__kstore', 'mcp__gitnexus'], ['kstore', 'gitnexus'])).not.toThrow()
  })

  it('accepts a per-tool grant (mcp__<server>__<tool>) as sufficient', () => {
    expect(() => assertMcpGrants('secretary', ['mcp__kstore__lesson_propose'], ['kstore'])).not.toThrow()
  })

  it('throws when a mounted server is not granted', () => {
    expect(() => assertMcpGrants('chief', ['Read'], ['kstore'])).toThrow(/mounts MCP server "kstore" but does not grant it/)
  })
})

describe('resolveAuthority — fail-closed over a crafted asset dir', () => {
  /** Build a minimal assetsDir with one tier's allowlist/mcp/bundle. */
  function craftAssets(tier: string, allowlist: unknown, mcp: unknown, bundle: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-authority-'))
    tmpDirs.push(dir)
    fs.mkdirSync(path.join(dir, 'allowlists'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'bundles'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'allowlists', `${tier}.json`), JSON.stringify(allowlist))
    fs.writeFileSync(path.join(dir, 'mcp', `${tier}.json`), JSON.stringify(mcp))
    fs.writeFileSync(path.join(dir, 'bundles', `${tier}.json`), JSON.stringify(bundle))
    return dir
  }

  it('throws when mcp/<tier>.json mounts a server the allowlist does not grant', () => {
    const assetsDir = craftAssets(
      'orchestrator',
      { allowedTools: ['Read'] },              // does NOT grant mcp__ghost
      { mcpServers: { ghost: { command: 'x' } } },
      { skills: [] },
    )
    expect(() => resolveAuthority('orchestrator', { assetsDir })).toThrow(/mcp__ghost/)
  })

  it('resolves cleanly when the mounted server IS granted', () => {
    const assetsDir = craftAssets(
      'orchestrator',
      { allowedTools: ['Read', 'mcp__ghost'] },
      { mcpServers: { ghost: { command: 'x' } } },
      { skills: ['search-first'] },
    )
    const a = resolveAuthority('orchestrator', { assetsDir })
    expect(a.mcpServers).toEqual(['ghost'])
    expect(a.skills).toEqual(['search-first'])
  })
})
