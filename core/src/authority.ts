/**
 * Authority resolver — tier → { allowedTools, mcpServers, skills }.
 *
 * The control plane's read half (bible §03, D-020/D-021/D-032/D-033/D-034):
 * authority is DATA, sourced from the committed, K-owned `agent-config/` assets,
 * not hardcoded. For a tier it resolves:
 *   - allowedTools ← `allowlists/<tier>.json` .allowedTools (the claude
 *     `--allowedTools` allowlist — the actual enforcement boundary)
 *   - mcpServers   ← the server KEYS of `mcp/<tier>.json` .mcpServers
 *   - skills       ← `bundles/<tier>.json` .skills (skill dir names)
 *
 * This is the same asset set the per-run synthesizer (agent-config.ts) reads to
 * build a run's config dir — so a profile row seeded from `resolveAuthority(tier)`
 * carries EXACTLY what the synthesizer will mount for that tier (the P5.0 seam
 * self-check). The synthesizer re-reads the assets itself; this resolver exists to
 * (a) record the resolved grant on the durable profile row and (b) enforce the
 * mcp↔allowlist invariant fail-closed at resolve/seed time.
 *
 * HARD RULES enforced/checked here:
 *   - The subagent-spawn token is literally `Task`, never `Agent` (D-032). Coding
 *     tools — Bash · Write · Edit · `Task` — exist ONLY at the `orchestrator` tier
 *     (D-021, corrected by D-032); `assertCodingToolsGating` proves it.
 *   - Every server mounted in `mcp/<tier>.json` MUST carry a matching `mcp__<server>`
 *     grant in `allowlists/<tier>.json` — otherwise the mounted server's tools are
 *     silently denied in headless `-p` (D-034: "mounting an MCP server ≠ granting
 *     it"). `resolveAuthority` runs this guard and THROWS if it is violated.
 *
 * Reads only the filesystem — no db, no supervisor — so it stays a pure,
 * dependency-light seam usable at module init (DEFAULT_PROFILE) and seed time.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentTier } from '@k/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirrors agent-config.ts DEFAULT_ASSETS_DIR: repo-root agent-config/.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')

/** The coding tools that exist ONLY at the orchestrator tier (D-021 → D-032).
 *  The subagent-spawn tool-id is `Task` (the CLI's literal token), never `Agent`. */
export const CODING_TOOLS = ['Bash', 'Write', 'Edit', 'Task'] as const

export interface TierAuthority {
  tier: AgentTier
  allowedTools: string[] // the claude --allowedTools allowlist for the tier
  mcpServers: string[] // MCP server keys the tier mounts
  skills: string[] // skill dir names the tier's bundle mounts
}

/** Read + JSON.parse a required asset, with a tier-scoped error on a bad/missing file. */
function readJson<T>(file: string, label: string): T {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`authority: ${label} not found at ${file}`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`authority: ${label} is not valid JSON (${file}): ${(e as Error).message}`)
  }
}

/**
 * Guard: every MCP server mounted for the tier must be granted in its allowlist —
 * either a server-level `mcp__<server>` grant or a per-tool `mcp__<server>__<tool>`
 * grant. Throws (fail-closed) on the first ungranted server. This is the runtime
 * teeth behind D-034's "mounting ≠ granting" lesson, so a seeded profile can never
 * carry a mounted-but-denied server.
 */
export function assertMcpGrants(tier: AgentTier, allowedTools: string[], mcpServers: string[]): void {
  for (const server of mcpServers) {
    const granted =
      allowedTools.includes(`mcp__${server}`) ||
      allowedTools.some(t => t.startsWith(`mcp__${server}__`))
    if (!granted) {
      throw new Error(
        `authority: tier "${tier}" mounts MCP server "${server}" but does not grant it ` +
          `(add "mcp__${server}" to allowlists/${tier}.json) — mounting an MCP server ≠ granting it`,
      )
    }
  }
}

/** True iff `tool` is permitted under a tier ceiling `ceiling` (a Set of the tier
 *  allowlist tokens). A tool is within the ceiling when it is an exact ceiling
 *  member, OR a specifier-narrowed form of one (`Bash(git:*)` narrows `Bash`), OR a
 *  per-tool MCP grant whose server-level grant the ceiling carries
 *  (`mcp__kstore__get_x` narrows `mcp__kstore`). */
export function toolWithinCeiling(tool: string, ceiling: ReadonlySet<string>): boolean {
  if (ceiling.has(tool)) return true
  const parenIdx = tool.indexOf('(')
  if (parenIdx > 0 && ceiling.has(tool.slice(0, parenIdx))) return true
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice(5)
    const sepIdx = rest.indexOf('__')
    if (sepIdx > 0 && ceiling.has('mcp__' + rest.slice(0, sepIdx))) return true
  }
  return false
}

/** Fail-closed ceiling guard (B1): every entry in `allowedTools` must be within the
 *  TIER's asset allowlist — the tier is the ceiling, per-profile rows only narrow
 *  within it (so a row can never re-grant coding tools to a non-coding tier, nor the
 *  dead `Agent` token anywhere). Throws on the first violation with a message the
 *  PATCH routes map to a 400. */
export function assertTierCeiling(tier: AgentTier, allowedTools: string[], opts: { assetsDir?: string } = {}): void {
  const ceiling = new Set(resolveAuthority(tier, opts).allowedTools)
  for (const tool of allowedTools) {
    if (!toolWithinCeiling(tool, ceiling)) {
      throw new Error(
        `authority: tool "${tool}" exceeds the "${tier}" tier ceiling — the tier allowlist is the ceiling; per-profile rows may only narrow within it`,
      )
    }
  }
}

/**
 * Resolve a tier's authority from the agent-config assets. Runs the mcp↔allowlist
 * grant guard (throws on violation). `assetsDir` is injectable for tests.
 */
export function resolveAuthority(tier: AgentTier, opts: { assetsDir?: string } = {}): TierAuthority {
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR

  const allow = readJson<{ allowedTools?: string[] }>(
    path.join(assetsDir, 'allowlists', `${tier}.json`),
    `allowlist for tier "${tier}"`,
  )
  const allowedTools = Array.isArray(allow.allowedTools) ? allow.allowedTools : []

  const mcp = readJson<{ mcpServers?: Record<string, unknown> }>(
    path.join(assetsDir, 'mcp', `${tier}.json`),
    `mcp config for tier "${tier}"`,
  )
  const mcpServers = Object.keys(mcp.mcpServers ?? {})

  const bundle = readJson<{ skills?: string[] }>(
    path.join(assetsDir, 'bundles', `${tier}.json`),
    `bundle for tier "${tier}"`,
  )
  const skills = Array.isArray(bundle.skills) ? bundle.skills : []

  // Fail-closed: a mounted-but-ungranted server would be silently denied in `-p`.
  assertMcpGrants(tier, allowedTools, mcpServers)

  return { tier, allowedTools, mcpServers, skills }
}

/**
 * Invariant check: coding tools (Bash/Write/Edit/Task) are present at the
 * orchestrator tier and ABSENT at secretary/chief. Exposed so a test — and any
 * future seed-time self-check — can prove the gating boundary holds across the
 * shipped assets. Throws on the first violation.
 */
export function assertCodingToolsGating(assetsDir?: string): void {
  const orch = resolveAuthority('orchestrator', { assetsDir })
  for (const tool of CODING_TOOLS) {
    if (!orch.allowedTools.includes(tool)) {
      throw new Error(`authority: orchestrator tier must grant coding tool "${tool}"`)
    }
  }
  for (const tier of ['secretary', 'chief'] as const) {
    const a = resolveAuthority(tier, { assetsDir })
    for (const tool of CODING_TOOLS) {
      if (a.allowedTools.includes(tool)) {
        throw new Error(`authority: non-coding tier "${tier}" must NOT grant coding tool "${tool}"`)
      }
    }
  }
  // `Agent` is never a valid grant token at ANY tier (D-032) — a stray one is dead
  // (the subagent-spawn tool-id is `Task`). Checked across all three tiers, including
  // orchestrator, so a mistakenly-added "Agent" grant can't slip through anywhere.
  for (const tier of ['orchestrator', 'secretary', 'chief'] as const) {
    if (resolveAuthority(tier, { assetsDir }).allowedTools.includes('Agent')) {
      throw new Error(`authority: tier "${tier}" carries dead token "Agent" (the tool-id is "Task")`)
    }
  }
}
