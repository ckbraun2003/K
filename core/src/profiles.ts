/**
 * Agent profiles — the K-owned identity + tier selection for a managed run, now a
 * DB-backed registry (P5.0). A profile names an authority `tier` (which
 * agent-config/ assets to materialize) and a `charter` (the asset basename to read;
 * === tier for the durable tiers). The synthesizer (agent-config.ts) reads `charter`
 * to build a run's ephemeral config dir; `allowedTools`/`mcpServers`/`skills` mirror
 * the tier's resolved authority (authority.ts) onto the row as a durable grant.
 *
 * The canonical shape is the `AgentProfile` Zod schema in `@k/shared` — re-exported
 * here so existing importers (agent-config.ts, tests) keep resolving it from
 * `./profiles.js`. `AgentTier` / `CharterName` are derived from it.
 *
 * Registry: getProfile / getProfileByName / listProfiles / createProfile /
 * updateProfile, plus seedProfiles() (idempotent, by name) which stands up the eight
 * durable rows — K, Chief, the default orchestrator, and the five discipline leads.
 */

import { randomUUID } from 'crypto'
import type { AgentProfile } from '@k/shared'
import { agentProfilesDb, rowToAgentProfile } from './db.js'
import { resolveAuthority, assertMcpGrants, assertCodingToolsGating } from './authority.js'

export type { AgentProfile } from '@k/shared'

/** Authority tier (bible §03): the durable station that gates what a profile may
 *  touch. The three durable tiers; worker agents are subagent DEFINITIONS
 *  (agent-config/agents/*.md) an orchestrator spawns, not a tier. */
export type AgentTier = AgentProfile['tier']

/** The charter-asset basename a profile materializes from agent-config/
 *  (tiers/<name>.charter.md, allowlists/<name>.json, mcp/<name>.json,
 *  bundles/<name>.json). MUST match a SHIPPED asset — only the three durable tiers
 *  exist. Usually === tier; kept as its own type so the synthesizer can never name a
 *  charter with no backing asset (which would crash synthesis at read time). */
export type CharterName = AgentProfile['charter']

/** The default model for a profile whose row does not override it — mirrors
 *  router.ts's CLAUDE_DEFAULT_MODEL so a routed model and a profiled model agree. */
function defaultModel(): string {
  return process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6'
}

// Orchestrator authority resolved once from the committed assets, for the in-memory
// fallback below. The assets are a guaranteed part of the repo (agent-config/), so
// this resolve is safe at module init; it also runs the mcp↔allowlist grant guard.
const ORCHESTRATOR_AUTHORITY = resolveAuthority('orchestrator')

/** The generic orchestrator profile — the staff-engineer that runs the delegation
 *  loop. This is the in-memory FALLBACK the supervisor uses when a run is dispatched
 *  without a resolved profile (e.g. today's `startRun` callers); its id/name match
 *  the durable `default-orchestrator` seed row so the two never diverge. */
export const DEFAULT_PROFILE: AgentProfile = {
  id: 'default-orchestrator',
  name: 'orchestrator',
  tier: 'orchestrator',
  charter: 'orchestrator',
  defaultModel: defaultModel(),
  // Copy the resolved arrays onto the exported fallback so a stray mutation of
  // DEFAULT_PROFILE (e.g. `.allowedTools.push(...)`) can't leak into the shared
  // ORCHESTRATOR_AUTHORITY and thus into every `opts.profile ?? DEFAULT_PROFILE`
  // dispatch. (Conductor P5.0 review nit.)
  allowedTools: [...ORCHESTRATOR_AUTHORITY.allowedTools],
  mcpServers: [...ORCHESTRATOR_AUTHORITY.mcpServers],
  skills: [...ORCHESTRATOR_AUTHORITY.skills],
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** Look up a profile by id (null if absent). */
export function getProfile(id: string): AgentProfile | null {
  const row = agentProfilesDb.getProfileRow.get(id) as Record<string, unknown> | undefined
  return row ? rowToAgentProfile(row) : null
}

/** Look up a profile by its unique name (null if absent). */
export function getProfileByName(name: string): AgentProfile | null {
  const row = agentProfilesDb.getProfileByNameRow.get(name) as Record<string, unknown> | undefined
  return row ? rowToAgentProfile(row) : null
}

/** All profiles, oldest first (seed order). */
export function listProfiles(): AgentProfile[] {
  return (agentProfilesDb.listProfileRows.all() as Record<string, unknown>[]).map(rowToAgentProfile)
}

export interface CreateProfileInput {
  /** Optional explicit id (the seed pins durable ids); a uuid is minted otherwise. */
  id?: string
  name: string
  tier: AgentTier
  /** Charter-asset basename; defaults to `tier` (the durable-tier convention). */
  charter?: CharterName
  /** Model id; defaults to the CLAUDE_MODEL env fallback. */
  defaultModel?: string
  // allowedTools/mcpServers/skills default to the tier's resolved authority when
  // omitted — the normal path. Provide them only to record an explicit override.
  allowedTools?: string[]
  mcpServers?: string[]
  skills?: string[]
}

/** Create + persist a profile. When the authority arrays are omitted they are
 *  resolved from the charter's assets (authority.ts), so a created row always
 *  carries a valid, grant-checked authority set. Returns the stored profile. */
export function createProfile(input: CreateProfileInput): AgentProfile {
  const id = input.id ?? randomUUID()
  const charter = input.charter ?? input.tier
  // Resolve the tier's authority for any omitted array (resolveAuthority also runs
  // the mcp↔allowlist grant guard on the assets).
  const auth = resolveAuthority(charter)
  const allowedTools = input.allowedTools ?? auth.allowedTools
  const mcpServers = input.mcpServers ?? auth.mcpServers
  const skills = input.skills ?? auth.skills
  // Guard the FINAL (possibly caller-overridden) values too, so an explicit override
  // can never persist a row that mounts an ungranted MCP server (D-034 fail-closed).
  assertMcpGrants(input.tier, allowedTools, mcpServers)
  agentProfilesDb.insertProfile.run({
    id,
    name: input.name,
    tier: input.tier,
    charter,
    defaultModel: input.defaultModel ?? defaultModel(),
    allowedTools: JSON.stringify(allowedTools),
    mcpServers: JSON.stringify(mcpServers),
    skills: JSON.stringify(skills),
    createdAt: Date.now(),
  })
  return rowToAgentProfile(agentProfilesDb.getProfileRow.get(id) as Record<string, unknown>)
}

export type UpdateProfileInput = Partial<Omit<CreateProfileInput, 'id'>>

/** Patch a profile's mutable fields (name/tier/charter/model/authority arrays).
 *  Unspecified fields keep their current value (read-merge-write, mirroring
 *  updateSkillContent). Returns the updated profile, or null if the id is unknown. */
export function updateProfile(id: string, patch: UpdateProfileInput): AgentProfile | null {
  const current = getProfile(id)
  if (!current) return null
  // Keep charter aligned with tier (the durable-tier convention charter===tier): a
  // tier patch that doesn't also name a charter moves the charter to the new tier.
  const nextCharter: CharterName = patch.charter ?? patch.tier ?? current.charter
  // If the charter changed and the caller didn't supply the authority arrays,
  // re-resolve them from the new charter's assets so the durable "inspectable grant"
  // row never desyncs from its tier. An unrelated patch (e.g. defaultModel) leaves the
  // existing arrays intact.
  const auth = nextCharter !== current.charter ? resolveAuthority(nextCharter) : null
  const merged: AgentProfile = {
    id: current.id,
    name: patch.name ?? current.name,
    tier: patch.tier ?? current.tier,
    charter: nextCharter,
    defaultModel: patch.defaultModel ?? current.defaultModel,
    allowedTools: patch.allowedTools ?? (auth ? auth.allowedTools : current.allowedTools),
    mcpServers: patch.mcpServers ?? (auth ? auth.mcpServers : current.mcpServers),
    skills: patch.skills ?? (auth ? auth.skills : current.skills),
  }
  // Fail-closed on the final values (mirrors createProfile).
  assertMcpGrants(merged.tier, merged.allowedTools, merged.mcpServers)
  agentProfilesDb.updateProfileRow.run({
    id: merged.id,
    name: merged.name,
    tier: merged.tier,
    charter: merged.charter,
    defaultModel: merged.defaultModel,
    allowedTools: JSON.stringify(merged.allowedTools),
    mcpServers: JSON.stringify(merged.mcpServers),
    skills: JSON.stringify(merged.skills),
  })
  return getProfile(id)
}

// ─── Seed ────────────────────────────────────────────────────────────────────

/** The eight durable org profiles (bible §03). Charter === tier for every row; the
 *  five discipline leads are all orchestrator-tier (discipline is a capability
 *  bundle + charter, NOT a directory — D-020). The default orchestrator keeps the
 *  `default-orchestrator` id/name so it aligns with DEFAULT_PROFILE. */
const SEED_PROFILES: ReadonlyArray<{ id: string; name: string; tier: AgentTier }> = [
  { id: 'k-secretary', name: 'K', tier: 'secretary' },
  { id: 'chief', name: 'Chief', tier: 'chief' },
  { id: 'default-orchestrator', name: 'orchestrator', tier: 'orchestrator' },
  { id: 'lead-frontend', name: 'Frontend', tier: 'orchestrator' },
  { id: 'lead-backend', name: 'Backend', tier: 'orchestrator' },
  { id: 'lead-systems', name: 'Systems', tier: 'orchestrator' },
  { id: 'lead-security', name: 'Security', tier: 'orchestrator' },
  { id: 'lead-network', name: 'Network', tier: 'orchestrator' },
]

/** Idempotently seed the durable profiles. Existing rows (matched by name) are left
 *  untouched so operator edits survive restarts. Returns the names newly inserted.
 *  Called at bootstrap (index.ts), mirroring seedBuiltinSkills / seedEvalSystems. */
export function seedProfiles(): string[] {
  // Fail-closed at seed time on BOTH hard rules: createProfile → resolveAuthority
  // already enforces the mcp↔allowlist grant guard per profile; this asserts the
  // coding-tools gating boundary once (Bash/Write/Edit/Task at orchestrator ONLY;
  // never `Agent`) so a broken asset set can't stand up a mis-scoped roster.
  assertCodingToolsGating()
  const created: string[] = []
  for (const seed of SEED_PROFILES) {
    if (getProfileByName(seed.name)) continue
    createProfile({ id: seed.id, name: seed.name, tier: seed.tier })
    created.push(seed.name)
  }
  if (created.length) console.log(`[profiles] seeded durable agent profiles: ${created.join(', ')}`)
  return created
}
