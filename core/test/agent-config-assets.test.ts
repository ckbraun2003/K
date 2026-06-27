/**
 * agent-config asset validator (Wave 1).
 *
 * `agent-config/` holds K's committed, K-owned config assets — the inputs the
 * per-run synthesizer (core/src/agent-config.ts, Wave 2) reads to build each
 * managed run's config dir. These assets must stay structurally valid even
 * before the synthesizer exists, so this test guards their shape:
 *   - the L0 base operating prompt is present, non-empty, recognizable.
 *   - every tier charter (L1) is a non-empty `.md`.
 *   - every allowlist/mcp JSON parses, and the tool-gating boundary holds
 *     (coding tools only at the coding tiers; none at chief/secretary).
 *   - every mcp config carries an `mcpServers` object.
 *   - the gitnexus skills are vendored with at least one SKILL.md.
 *
 * No DB, no supervisor — pure filesystem assertions over the asset dir.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ESM has no built-in __dirname; derive it so the asset path reads naturally.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')

/** Read + JSON.parse a file, asserting it is valid JSON (returns the value). */
function readJson(file: string): unknown {
  const raw = fs.readFileSync(file, 'utf8')
  return JSON.parse(raw)
}

describe('agent-config assets', () => {
  it('base-operating-prompt.md exists, is non-empty, and carries a recognizable marker', () => {
    const file = path.join(ASSET_DIR, 'base-operating-prompt.md')
    expect(fs.existsSync(file)).toBe(true)
    const body = fs.readFileSync(file, 'utf8')
    expect(body.trim().length).toBeGreaterThan(0)
    expect(body).toMatch(/Harness|Must \/ Must Not/)
  })

  it('every file in tiers/ is a non-empty .md', () => {
    const dir = path.join(ASSET_DIR, 'tiers')
    const files = fs.readdirSync(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      expect(name.endsWith('.md')).toBe(true)
      const body = fs.readFileSync(path.join(dir, name), 'utf8')
      expect(body.trim().length, `${name} should be non-empty`).toBeGreaterThan(0)
    }
  })

  it('every allowlists/*.json and mcp/*.json parses as valid JSON', () => {
    for (const sub of ['allowlists', 'mcp']) {
      const dir = path.join(ASSET_DIR, sub)
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      expect(files.length, `${sub} should contain JSON files`).toBeGreaterThan(0)
      for (const name of files) {
        expect(() => readJson(path.join(dir, name)), `${sub}/${name} should be valid JSON`).not.toThrow()
      }
    }
  })

  it('coding tiers (controller, lead, role) allow Bash/Write/Edit', () => {
    for (const tier of ['controller', 'lead', 'role']) {
      const cfg = readJson(path.join(ASSET_DIR, 'allowlists', `${tier}.json`)) as {
        allowedTools: string[]
      }
      expect(Array.isArray(cfg.allowedTools)).toBe(true)
      for (const tool of ['Bash', 'Write', 'Edit', 'Task']) {
        expect(cfg.allowedTools, `${tier} should allow ${tool}`).toContain(tool)
      }
    }
  })

  it('non-coding tiers (chief, secretary) allow NONE of Bash/Write/Edit/Agent/Task', () => {
    for (const tier of ['chief', 'secretary']) {
      const cfg = readJson(path.join(ASSET_DIR, 'allowlists', `${tier}.json`)) as {
        allowedTools: string[]
      }
      for (const tool of ['Bash', 'Write', 'Edit', 'Agent', 'Task']) {
        expect(cfg.allowedTools, `${tier} must NOT allow ${tool}`).not.toContain(tool)
      }
    }
  })

  it('every mcp/*.json has an mcpServers object', () => {
    const dir = path.join(ASSET_DIR, 'mcp')
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const name of files) {
      const cfg = readJson(path.join(dir, name)) as { mcpServers?: unknown }
      expect(cfg.mcpServers, `${name} should have mcpServers`).toBeDefined()
      expect(typeof cfg.mcpServers === 'object' && cfg.mcpServers !== null).toBe(true)
      expect(Array.isArray(cfg.mcpServers)).toBe(false)
    }
  })

  it('skills/gitnexus/ exists and vendors at least one */SKILL.md', () => {
    const gitnexusDir = path.join(ASSET_DIR, 'skills', 'gitnexus')
    expect(fs.existsSync(gitnexusDir)).toBe(true)
    const skillFiles = fs
      .readdirSync(gitnexusDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(gitnexusDir, d.name, 'SKILL.md'))
      .filter(p => fs.existsSync(p))
    expect(skillFiles.length).toBeGreaterThan(0)
  })
})
