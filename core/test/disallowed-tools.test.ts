/**
 * --disallowedTools hard tool ceiling (K-fixes wave, live-proof follow-up).
 *
 * The live K→Chief→lead proof showed `--allowedTools` is only an AUTO-APPROVAL
 * list: under `--permission-mode acceptEdits` (the supervisor default) Write/Edit
 * are auto-approved for EVERY tier, and other built-ins stay invocable subject to
 * prompts — the Chief wrote files and spawned an inline subagent despite a
 * no-coding allowlist. The fix: `computeDisallowedTools` (authority.ts) derives
 * the denylist UNIVERSE-minus-grant, the synthesizer returns it, and
 * buildClaudeArgs emits it as `--disallowedTools <tool…>` so the tier allowlist
 * becomes a real CEILING for built-ins (`--strict-mcp-config` already does this
 * for MCP).
 *
 * Covers: the pure computeDisallowedTools contract (incl. the Task/Agent alias
 * rule and specifier-narrowed grants), the chief/orchestrator synthesized
 * denylists, the argv placement, the empty-list dangling-flag guard, and a
 * profile-narrowed lead (row narrowing now has teeth at the CLI).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeDisallowedTools, CAPABILITY_TOOL_UNIVERSE } from '../src/authority.js'
import { synthesizeConfigDir } from '../src/agent-config.js'
import { buildClaudeArgs } from '../src/claude-args.js'
import { DEFAULT_PROFILE, type CharterName } from '../src/profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.join(__dirname, '../../agent-config')
const tmpDirs: string[] = []

function assetAllowedTools(tier: CharterName): string[] {
  return (
    JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'allowlists', `${tier}.json`), 'utf8')) as {
      allowedTools: string[]
    }
  ).allowedTools
}

/** Synthesize as a given charter tier into a fresh temp dataDir (S4 LOCK-suite
 *  pattern). Empty authority arrays = "no override → tier assets". */
function synthAs(charterTier: CharterName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-disallow-'))
  tmpDirs.push(dataDir)
  const runId = 'run-' + Math.random().toString(36).slice(2)
  const profile = { ...DEFAULT_PROFILE, tier: charterTier, charter: charterTier, allowedTools: [], mcpServers: [], skills: [] }
  return synthesizeConfigDir(profile, { runId, dataDir, assetsDir: ASSET_DIR })
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
})
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// The exact chief denylist: UNIVERSE minus the chief grant (WebFetch/WebSearch
// granted), in universe order — Task AND Agent denied together (alias rule).
const CHIEF_DENYLIST = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent']

describe('computeDisallowedTools — pure denylist derivation', () => {
  it('chief asset allowlist → exactly the non-granted universe tools, in universe order', () => {
    expect(computeDisallowedTools(assetAllowedTools('chief'))).toEqual(CHIEF_DENYLIST)
  })

  it('orchestrator asset allowlist → [] (every universe capability granted; Agent covered by the Task alias)', () => {
    expect(computeDisallowedTools(assetAllowedTools('orchestrator'))).toEqual([])
  })

  it('a specifier-narrowed grant counts: Bash(git:*) keeps Bash OFF the denylist', () => {
    const denied = computeDisallowedTools(['Bash(git:*)'])
    expect(denied).not.toContain('Bash')
    // …while every other non-spawn universe tool is denied.
    expect(denied).toContain('Write')
    expect(denied).toContain('WebFetch')
  })

  it('Task/Agent alias: Task granted → NEITHER Task nor Agent is denied', () => {
    const denied = computeDisallowedTools(['Task'])
    expect(denied).not.toContain('Task')
    expect(denied).not.toContain('Agent')
  })

  it('Task/Agent alias: neither granted → BOTH are denied', () => {
    const denied = computeDisallowedTools(['Read'])
    expect(denied).toContain('Task')
    expect(denied).toContain('Agent')
  })

  it('returns tools in universe order (a subsequence of CAPABILITY_TOOL_UNIVERSE)', () => {
    const denied = computeDisallowedTools(['Edit'])
    const universe = [...CAPABILITY_TOOL_UNIVERSE] as string[]
    expect(denied).toEqual(universe.filter(u => denied.includes(u)))
  })
})

describe('synthesized denylist + argv placement', () => {
  it('chief: cfg.disallowedTools denies every coding/spawn built-in but NOT the granted WebFetch/WebSearch', () => {
    const cfg = synthAs('chief')
    for (const tool of CHIEF_DENYLIST) {
      expect(cfg.disallowedTools, `chief must deny ${tool}`).toContain(tool)
    }
    expect(cfg.disallowedTools).not.toContain('WebFetch')
    expect(cfg.disallowedTools).not.toContain('WebSearch')

    const args = buildClaudeArgs('do something', {
      inWorktree: false,
      permissionMode: 'default',
      claudeConfig: {
        allowedTools: cfg.allowedTools,
        disallowedTools: cfg.disallowedTools,
        mcpConfigPath: cfg.mcpConfigPath,
        settingsPath: cfg.settingsPath,
        appendSystemPromptFile: cfg.appendSystemPromptFile,
      },
    })
    const iDis = args.indexOf('--disallowedTools')
    expect(iDis).toBeGreaterThanOrEqual(0)
    // Each denied tool is a SEPARATE argv element immediately after the flag.
    expect(args.slice(iDis + 1, iDis + 1 + cfg.disallowedTools.length)).toEqual(cfg.disallowedTools)
    // The block sits AFTER the last --allowedTools element…
    const iAllow = args.indexOf('--allowedTools')
    expect(iAllow).toBeGreaterThanOrEqual(0)
    expect(iDis).toBeGreaterThan(iAllow + cfg.allowedTools.length)
    // …and BEFORE --append-system-prompt-file.
    expect(iDis).toBeLessThan(args.indexOf('--append-system-prompt-file'))
  })

  it('orchestrator: cfg.disallowedTools is [] and the argv carries NO --disallowedTools', () => {
    const cfg = synthAs('orchestrator')
    expect(cfg.disallowedTools).toEqual([])
    const args = buildClaudeArgs('do something', {
      inWorktree: false,
      permissionMode: 'default',
      claudeConfig: {
        allowedTools: cfg.allowedTools,
        disallowedTools: cfg.disallowedTools,
        mcpConfigPath: cfg.mcpConfigPath,
        settingsPath: cfg.settingsPath,
        appendSystemPromptFile: cfg.appendSystemPromptFile,
      },
    })
    expect(args).not.toContain('--disallowedTools')
  })

  it('dangling-flag guard: an empty denylist emits no --disallowedTools and never swallows the prompt-file flag', () => {
    const args = buildClaudeArgs('do something', {
      inWorktree: false,
      permissionMode: 'default',
      claudeConfig: {
        allowedTools: ['Read'],
        disallowedTools: [],
        mcpConfigPath: '/run/cfg/mcp.json',
        settingsPath: '/run/cfg/settings.json',
        appendSystemPromptFile: '/run/cfg/system-prompt.md',
      },
    })
    expect(args).not.toContain('--disallowedTools')
    const j = args.indexOf('--append-system-prompt-file')
    expect(j).toBeGreaterThanOrEqual(0)
    expect(args[j + 1]).toBe('/run/cfg/system-prompt.md')
  })
})

describe('profile-narrowed lead — row narrowing has teeth at the CLI', () => {
  it('an orchestrator profile narrowed to drop WebFetch yields disallowedTools === [WebFetch]', () => {
    const narrowed = assetAllowedTools('orchestrator').filter(t => t !== 'WebFetch')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-disallow-narrow-'))
    tmpDirs.push(dataDir)
    const profile = {
      ...DEFAULT_PROFILE,
      tier: 'orchestrator' as const,
      charter: 'orchestrator' as const,
      allowedTools: narrowed,
      mcpServers: [],
      skills: [],
    }
    const cfg = synthesizeConfigDir(profile, {
      runId: 'run-' + Math.random().toString(36).slice(2),
      dataDir,
      assetsDir: ASSET_DIR,
    })
    expect(cfg.disallowedTools).toEqual(['WebFetch'])
  })
})
