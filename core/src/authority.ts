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
import { assertSafeSkillKey, SkillKeyError } from './skill-roots.js'
import {
  getCatalogSkillRow,
  getHostMcpServerRow,
  listEnabledDiscoveredSkillKeys,
  listEnabledTrustedHostMcpServers,
} from './host-discovery.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirrors agent-config.ts DEFAULT_ASSETS_DIR: repo-root agent-config/.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')

/** The coding tools that exist ONLY at the orchestrator tier (D-021 → D-032).
 *  The subagent-spawn tool-id is `Task` (the CLI's literal token), never `Agent`. */
export const CODING_TOOLS = ['Bash', 'Write', 'Edit', 'Task'] as const

/** The authority-bearing BUILT-IN tools the CLI exposes. `--allowedTools` is only an
 *  auto-approval list — under `--permission-mode acceptEdits` (the supervisor default)
 *  Write/Edit are auto-approved for EVERY tier and other built-ins stay invocable subject
 *  to prompts. The denylist (UNIVERSE minus the run's granted tools) is what makes the
 *  tier allowlist a real CEILING for built-ins (`--strict-mcp-config` already does this
 *  for MCP). `Task` and `Agent` are ONE capability (subagent spawn) under two CLI names —
 *  D-032 verified `Task`; the live Chief proof showed the CLI exposing `Agent` — so the
 *  pair is granted/denied together (see computeDisallowedTools). */
export const CAPABILITY_TOOL_UNIVERSE = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch'] as const

/**
 * Derive the run's `--disallowedTools` denylist: CAPABILITY_TOOL_UNIVERSE minus the
 * granted tools, in universe order. A universe tool counts as granted when
 * `allowedTools` carries it exactly OR as a specifier-narrowed form (`Bash(git:*)`
 * grants Bash — mirroring toolWithinCeiling's paren logic; no mcp__ handling here,
 * the universe has none). Task/Agent alias rule: if EITHER is granted NEITHER is
 * denied; if neither, BOTH are — denying `Agent` while `Task` is granted could kill
 * the spawn tool under its other name, and assets never grant `Agent`
 * (assertCodingToolsGating forbids it), so without the alias rule every orchestrator
 * run would carry a bogus denylist.
 */
export function computeDisallowedTools(allowedTools: string[]): string[] {
  const granted = (universeTool: string): boolean =>
    allowedTools.some(t => {
      if (t === universeTool) return true
      const parenIdx = t.indexOf('(')
      return parenIdx > 0 && t.slice(0, parenIdx) === universeTool
    })
  const spawnGranted = granted('Task') || granted('Agent')
  return CAPABILITY_TOOL_UNIVERSE.filter(u =>
    u === 'Task' || u === 'Agent' ? !spawnGranted : !granted(u),
  )
}

/** The fail-closed CLIENT-ERROR signal from the two grant guards — assertMcpGrants
 *  ("mounting ≠ granting", D-034) and assertTierCeiling (the B1 tier ceiling). The
 *  PATCH routes (orchestrators / org-default) map an `instanceof GrantError` to a
 *  400 with the message verbatim; any other throw is a server fault → 500. A typed
 *  class instead of message-regex matching, so the routes can't drift from the
 *  guard wording. */
export class GrantError extends Error {}

export interface TierAuthority {
  tier: AgentTier
  allowedTools: string[] // the claude --allowedTools allowlist for the tier
  mcpServers: string[] // MCP server keys the tier mounts
  skills: string[] // skill dir names the tier's bundle mounts
  /** D-069 tier opt-in: may this tier be granted host-DISCOVERED skills (by
   *  qualified key)? From bundles/<tier>.json; absent → false (fail-closed). */
  allowDiscoveredSkills: boolean
  /** D-070 tier opt-in: may this tier be granted host-discovered MCP servers?
   *  From mcp/<tier>.json; absent → false (fail-closed). */
  allowDiscoveredServers: boolean
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
 * grant. Throws GrantError (fail-closed) on the first ungranted server. This is the
 * runtime teeth behind D-034's "mounting ≠ granting" lesson, so a seeded profile can
 * never carry a mounted-but-denied server.
 */
export function assertMcpGrants(tier: AgentTier, allowedTools: string[], mcpServers: string[]): void {
  for (const server of mcpServers) {
    const granted =
      allowedTools.includes(`mcp__${server}`) ||
      allowedTools.some(t => t.startsWith(`mcp__${server}__`))
    if (!granted) {
      throw new GrantError(
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
 *  dead `Agent` token anywhere). Throws GrantError on the first violation — the
 *  typed signal the PATCH routes map to a 400.
 *  STATUS (D-069): profiles.ts moved to assertEffectiveGrants (which inherits this
 *  guard's VERBATIM wording for tier-only rejections); kept exported as the
 *  tier-asset-only primitive + its wording contract (authority-ceiling.test.ts). */
export function assertTierCeiling(tier: AgentTier, allowedTools: string[], opts: { assetsDir?: string } = {}): void {
  const ceiling = new Set(resolveAuthority(tier, opts).allowedTools)
  for (const tool of allowedTools) {
    if (!toolWithinCeiling(tool, ceiling)) {
      throw new GrantError(
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

  const mcp = readJson<{ mcpServers?: Record<string, unknown>; allowDiscoveredServers?: unknown }>(
    path.join(assetsDir, 'mcp', `${tier}.json`),
    `mcp config for tier "${tier}"`,
  )
  const mcpServers = Object.keys(mcp.mcpServers ?? {})

  const bundle = readJson<{ skills?: string[]; allowDiscoveredSkills?: unknown }>(
    path.join(assetsDir, 'bundles', `${tier}.json`),
    `bundle for tier "${tier}"`,
  )
  const skills = Array.isArray(bundle.skills) ? bundle.skills : []

  // Fail-closed: a mounted-but-ungranted server would be silently denied in `-p`.
  assertMcpGrants(tier, allowedTools, mcpServers)

  return {
    tier,
    allowedTools,
    mcpServers,
    skills,
    // D-069/D-070 tier opt-ins: STRICT `=== true` so a truthy-but-wrong value
    // ("yes", 1) in a hand-edited asset can never widen the ceiling (fail-closed).
    allowDiscoveredSkills: bundle.allowDiscoveredSkills === true,
    allowDiscoveredServers: mcp.allowDiscoveredServers === true,
  }
}

// ─── D-069/D-070: the EFFECTIVE ceiling (tier assets ∪ admitted discovered) ────

/**
 * The full grant ceiling for a tier once host-discovered assets are considered:
 * the tier's asset authority PLUS — where the tier opts in — the operator-enabled
 * discovered assets. Invariant (host-integration plan): operator ENABLEMENT is a
 * precondition, tier OPT-IN is the ceiling, profile assignment NARROWS.
 *
 * ONE source for both consumers: profiles.ts create/updateProfile validation and
 * the run-asset resolution (run-assets.ts) both call this — so what a PATCH
 * accepts and what a dispatch mounts can never drift.
 */
export interface EffectiveCeiling {
  tier: AgentTier
  /** The tier's own asset authority (allowlist/template/bundle). */
  base: TierAuthority
  /** Enabled + status-ok discovered skill QUALIFIED KEYS the tier admits
   *  (empty when the tier's bundle does not opt in). */
  discoveredSkills: Set<string>
  /** Admitted discovered MCP servers: qualified key → server NAME (the mcp__<name>
   *  grant token / mount key). Enabled + TRUSTED (pin matches the current config
   *  hash) + status-ok only; empty when the tier's template does not opt in. */
  discoveredServers: Map<string, string>
  /** The WIDENED allowedTools ceiling: the tier allowlist ∪ an `mcp__<name>` grant
   *  per admitted discovered server (the ceiling widens in LOCKSTEP with the
   *  server admission — a grant for a non-admitted server stays above-ceiling). */
  allowedTools: Set<string>
}

/** Resolve the effective (tier ∪ admitted-discovered) ceiling. Reads the tier
 *  assets from disk and the discovered catalog from the db. */
export function resolveEffectiveCeiling(tier: AgentTier, opts: { assetsDir?: string } = {}): EffectiveCeiling {
  const base = resolveAuthority(tier, opts)
  const discoveredSkills = new Set<string>()
  const discoveredServers = new Map<string, string>()
  if (base.allowDiscoveredSkills) {
    for (const key of listEnabledDiscoveredSkillKeys()) discoveredSkills.add(key)
  }
  if (base.allowDiscoveredServers) {
    for (const srv of listEnabledTrustedHostMcpServers()) discoveredServers.set(srv.qualifiedKey, srv.name)
  }
  const allowedTools = new Set(base.allowedTools)
  for (const name of discoveredServers.values()) allowedTools.add(`mcp__${name}`)
  return { tier, base, discoveredSkills, discoveredServers, allowedTools }
}

/** Why a discovered-skill grant is rejected — looked up for an ACTIONABLE
 *  GrantError (the 400 banner names the asset and the fix). */
function describeSkillRejection(tier: AgentTier, key: string): string {
  const row = getCatalogSkillRow(key)
  if (!row) {
    return `authority: discovered skill "${key}" is not in the capability catalog — rescan the host or correct the key`
  }
  if (row.status !== 'ok') {
    return `authority: discovered skill "${key}" is missing on the host (status=${String(row.status)}) — restore it and rescan, or remove the grant`
  }
  if (Number(row.enabled) !== 1) {
    return `authority: discovered skill "${key}" is disabled — enable it in the capability catalog first`
  }
  return `authority: discovered skill "${key}" is not admitted for tier "${tier}"`
}

/** Why a discovered-MCP grant is rejected (D-070: enable requires trust). */
function describeServerRejection(tier: AgentTier, key: string): string {
  const row = getHostMcpServerRow(key)
  if (!row) {
    return `authority: discovered MCP server "${key}" is not in the capability catalog — rescan the host or correct the key`
  }
  if (row.status !== 'ok') {
    return `authority: discovered MCP server "${key}" is missing on the host (status=${String(row.status)}) — restore it and rescan, or remove the grant`
  }
  if (row.trusted_hash == null || row.trusted_hash !== row.config_hash) {
    return `authority: discovered MCP server "${key}" is not trusted — review and trust it in the capability catalog first (enabling requires trust, D-070)`
  }
  if (Number(row.enabled) !== 1) {
    return `authority: discovered MCP server "${key}" is disabled — enable it in the capability catalog first`
  }
  return `authority: discovered MCP server "${key}" is not admitted for tier "${tier}"`
}

/** The three grant arrays a profile row carries (profiles.ts) / a run resolves. */
export interface ProfileGrants {
  allowedTools: string[]
  mcpServers: string[]
  skills: string[]
}

/**
 * Fail-closed validation of a profile's FINAL grant arrays against the tier's
 * EFFECTIVE ceiling. Replaces the assertTierCeiling+assertMcpGrants pair at the
 * profile boundary and is reused by run-asset resolution (one source, no drift).
 * Throws the typed GrantError (→ the routes' existing 400 mapping) on the first
 * violation. Semantics:
 *   - allowedTools: every entry within the WIDENED ceiling (a strict superset of
 *     the old tier-only check — every previously-valid grant stays valid, and the
 *     assertTierCeiling message is kept verbatim for the tier-only rejections);
 *   - skills: BARE names are deliberately NOT validated here — the synth bundle
 *     ceiling handles them exactly as today (regression lock: the bare-name PATCH
 *     flow stays byte-identical). QUALIFIED keys must parse (assertSafeSkillKey)
 *     and resolve to an ADMITTED discovered skill (tier opt-in + enabled + ok);
 *   - mcpServers: bare names keep today's assertMcpGrants path verbatim;
 *     qualified keys must resolve to an ADMITTED discovered server (tier opt-in +
 *     enabled + trusted + ok), and their mcp__<NAME> grant must be present in
 *     allowedTools (D-034 "mounting ≠ granting" extended to discovered mounts).
 * Returns the resolved EffectiveCeiling so callers can reuse it without a second
 * resolve.
 */
export function assertEffectiveGrants(
  tier: AgentTier,
  grants: ProfileGrants,
  opts: { assetsDir?: string } = {},
): EffectiveCeiling {
  const ceiling = resolveEffectiveCeiling(tier, opts)

  // Asset-admission checks run FIRST: when a patch carries both a rejected
  // discovered asset AND its (now-above-ceiling) mcp__<name> grant, the error
  // that surfaces must NAME THE ASSET and its fix ("not trusted — trust it"),
  // not the derived tool-ceiling symptom.
  for (const entry of grants.skills) {
    if (!entry.includes(':')) continue // bare k-native name — the synth bundle ceiling covers it, exactly today
    try {
      assertSafeSkillKey(entry)
    } catch (e) {
      if (!(e instanceof SkillKeyError)) throw e
      throw new GrantError(`authority: skill grant "${entry}" is not a valid catalog key — ${e.message}`)
    }
    if (!ceiling.base.allowDiscoveredSkills) {
      throw new GrantError(
        `authority: tier "${tier}" does not admit discovered skills — remove "${entry}" or set allowDiscoveredSkills in bundles/${tier}.json`,
      )
    }
    if (!ceiling.discoveredSkills.has(entry)) throw new GrantError(describeSkillRejection(tier, entry))
  }

  const mountedNames: string[] = []
  for (const entry of grants.mcpServers) {
    if (!entry.includes(':')) {
      mountedNames.push(entry) // tier-template server — today's grant check below
      continue
    }
    try {
      assertSafeSkillKey(entry) // same ONE canonical key grammar
    } catch (e) {
      if (!(e instanceof SkillKeyError)) throw e
      throw new GrantError(`authority: MCP grant "${entry}" is not a valid catalog key — ${e.message}`)
    }
    if (!ceiling.base.allowDiscoveredServers) {
      throw new GrantError(
        `authority: tier "${tier}" does not admit discovered MCP servers — remove "${entry}" or set allowDiscoveredServers in mcp/${tier}.json`,
      )
    }
    const name = ceiling.discoveredServers.get(entry)
    if (!name) throw new GrantError(describeServerRejection(tier, entry))
    mountedNames.push(name) // the grant token keys on the server NAME, not the qualified key
  }

  for (const tool of grants.allowedTools) {
    if (!toolWithinCeiling(tool, ceiling.allowedTools)) {
      // Verbatim assertTierCeiling wording — the pre-D-069 rejections read identically.
      throw new GrantError(
        `authority: tool "${tool}" exceeds the "${tier}" tier ceiling — the tier allowlist is the ceiling; per-profile rows may only narrow within it`,
      )
    }
  }

  // D-034 for the whole mounted set: tier servers under their bare name, discovered
  // servers under their resolved name — every mount needs its mcp__<name> grant.
  assertMcpGrants(tier, grants.allowedTools, mountedNames)

  return ceiling
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
