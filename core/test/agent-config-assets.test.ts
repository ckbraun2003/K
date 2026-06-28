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

  it('ships exactly the three durable tiers (secretary, chief, orchestrator) for every asset kind', () => {
    const expected = ['chief', 'orchestrator', 'secretary']
    const tiers = fs.readdirSync(path.join(ASSET_DIR, 'tiers')).map(f => f.replace('.charter.md', '')).sort()
    expect(tiers).toEqual(expected)
    for (const sub of ['allowlists', 'mcp']) {
      const names = fs.readdirSync(path.join(ASSET_DIR, sub)).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort()
      expect(names, `${sub} tiers`).toEqual(expected)
    }
    // the removed taxonomy must not linger anywhere
    for (const dead of ['controller', 'lead', 'role']) {
      expect(fs.existsSync(path.join(ASSET_DIR, 'tiers', `${dead}.charter.md`)), `tiers/${dead}`).toBe(false)
      expect(fs.existsSync(path.join(ASSET_DIR, 'allowlists', `${dead}.json`)), `allowlists/${dead}`).toBe(false)
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

  it('the coding tier (orchestrator) allows Bash/Write/Edit/Task', () => {
    for (const tier of ['orchestrator']) {
      const cfg = readJson(path.join(ASSET_DIR, 'allowlists', `${tier}.json`)) as {
        allowedTools: string[]
      }
      expect(Array.isArray(cfg.allowedTools)).toBe(true)
      for (const tool of ['Bash', 'Write', 'Edit', 'Task', 'mcp__gitnexus']) {
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

describe('vendored practice skills', () => {
  // The curated methodology skills mounted into every managed run, plus K's own
  // memory-practice skill. Each is an adapted copy — de-coupled from any host or
  // plugin paths — so it must stay inside the project worktree's idiom.
  const VENDORED = [
    'search-first',
    'strategic-compact',
    'iterative-retrieval',
    'test-driven-development',
    'verification-before-completion',
    'subagent-driven-development',
    'requesting-code-review',
    'receiving-code-review',
    'systematic-debugging',
    'capturing-lessons',
  ]

  // Markers that would mean the skill still points outside K (host config dirs,
  // plugin commands, or the file-based stores K replaced with tools).
  const OUT_OF_K_MARKERS = [
    'docs/superpowers/',
    '~/.claude',
    '/learn',
    'learned/',
    'tasks/todo.md',
    'tasks/lessons.md',
  ]

  /** Pull the `name:` value from the leading `---`-fenced YAML frontmatter. */
  function frontmatterName(body: string): string | undefined {
    const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fence) return undefined
    const line = fence[1].split(/\r?\n/).find(l => /^name:\s*/.test(l))
    return line?.replace(/^name:\s*/, '').trim()
  }

  for (const skill of VENDORED) {
    it(`${skill}/SKILL.md exists, is non-empty, and its frontmatter name matches the dir`, () => {
      const file = path.join(ASSET_DIR, 'skills', skill, 'SKILL.md')
      expect(fs.existsSync(file), `${skill}/SKILL.md should exist`).toBe(true)
      const body = fs.readFileSync(file, 'utf8')
      expect(body.trim().length, `${skill} should be non-empty`).toBeGreaterThan(0)
      expect(frontmatterName(body), `${skill} frontmatter name`).toBe(skill)
    })
  }

  it('no vendored skill body references an out-of-K location', () => {
    for (const skill of VENDORED) {
      const body = fs.readFileSync(path.join(ASSET_DIR, 'skills', skill, 'SKILL.md'), 'utf8')
      for (const marker of OUT_OF_K_MARKERS) {
        expect(body.includes(marker), `${skill} must not contain "${marker}"`).toBe(false)
      }
    }
  })
})

describe('worker-agent definitions (agents/*.md)', () => {
  // Worker agents are subagent DEFINITIONS an orchestrator spawns via the `Task`
  // tool. Each carries its own tool scope (⊆ the spawning tier's allowlist) so
  // authority is bounded per role: reviewers/debugger/planner never write.
  const AGENTS_DIR = path.join(ASSET_DIR, 'agents')
  const EXPECTED_ROSTER = [
    'debugger',
    'implementer',
    'planner',
    'quality-reviewer',
    'security-reviewer',
    'spec-reviewer',
  ]

  // The orchestrator allowlist is the ceiling: a mounted agent may never grant a
  // tool the tier that spawns it lacks.
  function orchestratorAllowed(): string[] {
    const cfg = readJson(path.join(ASSET_DIR, 'allowlists', 'orchestrator.json')) as {
      allowedTools: string[]
    }
    return cfg.allowedTools
  }

  /** Parse the `---`-fenced frontmatter of an agent def: name, description, tools[]. */
  function parseAgentFrontmatter(body: string): {
    name?: string
    description?: string
    tools?: string[]
  } {
    const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fence) return {}
    const lines = fence[1].split(/\r?\n/)
    const name = lines.find(l => /^name:\s*/.test(l))?.replace(/^name:\s*/, '').trim()
    const description = lines
      .find(l => /^description:\s*/.test(l))
      ?.replace(/^description:\s*/, '')
      .trim()
    const toolsLine = lines.find(l => /^tools:\s*\[/.test(l))?.replace(/^tools:\s*/, '').trim()
    let tools: string[] | undefined
    if (toolsLine) {
      try {
        tools = JSON.parse(toolsLine) as string[]
      } catch {
        tools = undefined
      }
    }
    return { name, description, tools }
  }

  it('ships exactly the expected worker-agent roster', () => {
    const files = fs
      .readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort()
    expect(files).toEqual(EXPECTED_ROSTER)
  })

  for (const agent of EXPECTED_ROSTER) {
    it(`${agent}.md parses; name matches file; description + tools[] present; tools ⊆ orchestrator allowlist`, () => {
      const body = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8')
      const fm = parseAgentFrontmatter(body)
      expect(fm.name, `${agent} frontmatter name`).toBe(agent)
      expect((fm.description ?? '').length, `${agent} description`).toBeGreaterThan(0)
      expect(Array.isArray(fm.tools) && fm.tools.length > 0, `${agent} tools[]`).toBe(true)
      const allowed = orchestratorAllowed()
      for (const tool of fm.tools as string[]) {
        expect(allowed, `${agent} tool ${tool} must be ⊆ orchestrator allowlist`).toContain(tool)
      }
      // body (system prompt) is non-empty
      expect(body.replace(/^---[\s\S]*?---/, '').trim().length, `${agent} body`).toBeGreaterThan(0)
    })
  }

  it('no agent body references an out-of-K host/plugin location', () => {
    // implementer.md legitimately NAMES tasks/*.md to forbid them, so we scan only
    // the host/plugin path markers here — never the task-file names themselves.
    const HOST_MARKERS = ['docs/superpowers/', '~/.claude', '/learn', 'learned/']
    for (const agent of EXPECTED_ROSTER) {
      const body = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8')
      for (const marker of HOST_MARKERS) {
        expect(body.includes(marker), `${agent} must not contain "${marker}"`).toBe(false)
      }
    }
  })

  it('only the implementer may write; reviewers/debugger/planner are read-only (no Write/Edit/Task)', () => {
    for (const agent of EXPECTED_ROSTER) {
      const body = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8')
      const tools = parseAgentFrontmatter(body).tools ?? []
      if (agent === 'implementer') {
        for (const tool of ['Write', 'Edit', 'Task']) {
          expect(tools, `implementer should allow ${tool}`).toContain(tool)
        }
      } else {
        for (const tool of ['Write', 'Edit', 'Task']) {
          expect(tools, `${agent} must NOT allow ${tool}`).not.toContain(tool)
        }
      }
    }
  })
})

describe('charter bundles (bundles/*.json)', () => {
  // A bundle declares, per charter tier, exactly which vendored skills and which
  // worker-agent defs the synthesizer mounts. The authority boundary is encoded
  // here too: only the orchestrator bundle carries coding agents.
  const BUNDLES_DIR = path.join(ASSET_DIR, 'bundles')
  const TIERS = ['chief', 'orchestrator', 'secretary']

  /** A skill entry resolves if skills/<name>/ holds a SKILL.md directly or in a subdir. */
  function skillResolves(name: string): boolean {
    const dir = path.join(ASSET_DIR, 'skills', name)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return true
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .some(d => fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
  }

  it('ships exactly one bundle per durable tier', () => {
    const names = fs
      .readdirSync(BUNDLES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort()
    expect(names).toEqual(TIERS)
  })

  for (const tier of TIERS) {
    it(`${tier}.json parses with skills[]/agents[] that all resolve to existing assets`, () => {
      const cfg = readJson(path.join(BUNDLES_DIR, `${tier}.json`)) as {
        skills?: unknown
        agents?: unknown
      }
      expect(Array.isArray(cfg.skills), `${tier} skills[]`).toBe(true)
      expect(Array.isArray(cfg.agents), `${tier} agents[]`).toBe(true)
      for (const skill of cfg.skills as string[]) {
        expect(skillResolves(skill), `${tier} skill "${skill}" must resolve`).toBe(true)
      }
      for (const agent of cfg.agents as string[]) {
        expect(
          fs.existsSync(path.join(ASSET_DIR, 'agents', `${agent}.md`)),
          `${tier} agent "${agent}" must resolve`,
        ).toBe(true)
      }
    })
  }

  it('only the orchestrator bundle mounts coding worker-agents; chief/secretary mount none', () => {
    for (const tier of ['chief', 'secretary']) {
      const cfg = readJson(path.join(BUNDLES_DIR, `${tier}.json`)) as { agents: string[] }
      expect(cfg.agents, `${tier} must mount no worker-agents`).toEqual([])
    }
    const orch = readJson(path.join(BUNDLES_DIR, 'orchestrator.json')) as { agents: string[] }
    // The orchestrator must mount the COMPLETE roster — every def on disk, nothing
    // missing and nothing dangling — so the bundle and agents/ can never drift apart.
    const roster = fs
      .readdirSync(path.join(ASSET_DIR, 'agents'))
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort()
    expect([...orch.agents].sort(), 'orchestrator bundle must mount every worker-agent def').toEqual(
      roster,
    )
  })
})
