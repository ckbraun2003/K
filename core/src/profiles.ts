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
import { agentProfilesDb, configDb, db, rowToAgentProfile } from './db.js'
import { resolveAuthority, assertEffectiveGrants, assertCodingToolsGating } from './authority.js'

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
  // null = no per-profile override — the runtime Claude default (config-store
  // claudeDefaultModel()) is resolved at dispatch time, never frozen here.
  defaultModel: null,
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
  /** Explicit model override; omitted/null = use the runtime Claude default at dispatch. */
  defaultModel?: string | null
  /** L1.5 identity overlay (D-126); omitted/null = no overlay. */
  identityOverlay?: string | null
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
  // null = no override — dispatch resolves the runtime Claude default
  // (config-store claudeDefaultModel()) at startAgentRun time.
  const defaultModel = input.defaultModel ?? null
  // Guard the FINAL (possibly caller-overridden) values too, so an explicit override
  // can never persist a row that exceeds the tier ceiling (B1 fail-closed), mounts
  // an ungranted MCP server (D-034 fail-closed), or grants a discovered asset the
  // tier/operator hasn't admitted (D-069/D-070 — assertEffectiveGrants widens the
  // old assertTierCeiling+assertMcpGrants pair to the EFFECTIVE ceiling; bare-name
  // flows are byte-identical). Keyed by CHARTER — the same asset set the defaults
  // above were resolved from and the synthesizer will read at dispatch (charter ===
  // tier for every durable row; one asset set, no silent divergence).
  assertEffectiveGrants(charter, { allowedTools, mcpServers, skills })
  agentProfilesDb.insertProfile.run({
    id,
    name: input.name,
    tier: input.tier,
    charter,
    // '' is the storage sentinel for "no override" (the column is TEXT NOT NULL —
    // see rowToAgentProfile, which surfaces it as null at the app boundary).
    defaultModel: defaultModel ?? '',
    allowedTools: JSON.stringify(allowedTools),
    mcpServers: JSON.stringify(mcpServers),
    skills: JSON.stringify(skills),
    // NULL = no overlay (the column is nullable — no '' sentinel here; '' is a
    // meaningful "silence the seed" value, see rowToAgentProfile).
    identityOverlay: input.identityOverlay ?? null,
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
    // Distinguish "absent" (keep current) from an explicit null (CLEAR the override
    // back to the runtime Claude default) — `??` would conflate the two.
    defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : current.defaultModel,
    // Same absent-vs-null convention: an explicit null CLEARS the overlay (back to
    // NULL, i.e. re-seedable); absent keeps the current value.
    identityOverlay: patch.identityOverlay !== undefined ? patch.identityOverlay : current.identityOverlay,
    allowedTools: patch.allowedTools ?? (auth ? auth.allowedTools : current.allowedTools),
    mcpServers: patch.mcpServers ?? (auth ? auth.mcpServers : current.mcpServers),
    skills: patch.skills ?? (auth ? auth.skills : current.skills),
  }
  // Fail-closed on the final values (mirrors createProfile): the EFFECTIVE ceiling
  // (B1 tier ceiling ∪ admitted discovered assets, keyed by CHARTER — the asset set
  // the synthesizer will read at dispatch) + mcp↔allowlist grant guard (D-034) +
  // discovered-asset admission (D-069/D-070). A disabled/missing/untrusted
  // discovered grant fail-closes THIS patch with an actionable GrantError → 400.
  assertEffectiveGrants(merged.charter, {
    allowedTools: merged.allowedTools,
    mcpServers: merged.mcpServers,
    skills: merged.skills,
  })
  agentProfilesDb.updateProfileRow.run({
    id: merged.id,
    name: merged.name,
    tier: merged.tier,
    charter: merged.charter,
    // '' = the "no override" storage sentinel (see rowToAgentProfile).
    defaultModel: merged.defaultModel ?? '',
    allowedTools: JSON.stringify(merged.allowedTools),
    mcpServers: JSON.stringify(merged.mcpServers),
    skills: JSON.stringify(merged.skills),
    identityOverlay: merged.identityOverlay ?? null,
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

/** L1.5 seed overlays (C.2, D-126). NULL-only stamping (the domain-stamp
 *  default-membership posture): an operator edit — including blanking to '' —
 *  survives every re-seed; only NULL (never customized / cleared for re-seed)
 *  is covered. */
const SEED_IDENTITY_OVERLAYS: ReadonlyArray<{ id: string; overlay: string }> = [
  { id: 'chief', overlay: [
    '## Identity: Chief — Engineering Manager',
    '',
    "You are the **Chief**, the Engineering domain's manager and the operator's",
    'right hand. Your domain is the engineering org: the five discipline leads',
    '(Frontend, Backend, Systems, Security, Network) and the engineering pipeline',
    'library. You are woken by a schedule, an org event (a lead report, a dispatch',
    'completing, a domain briefing), or the user via K.',
  ].join('\n') },
  { id: 'lead-frontend', overlay: [
    '## Identity: Frontend lead',
    '',
    'You own web UI work: components, pages, styling and design-system compliance',
    '(tokens only), accessibility, and the web test suites.',
  ].join('\n') },
  { id: 'lead-backend', overlay: [
    '## Identity: Backend lead',
    '',
    'You own server-side work: APIs and routes, business logic, data models and',
    'migrations, and the core service test suites.',
  ].join('\n') },
  { id: 'lead-systems', overlay: [
    '## Identity: Systems lead',
    '',
    'You own infrastructure and tooling: build and CI pipelines, packaging,',
    'performance, and cross-cutting developer experience.',
  ].join('\n') },
  { id: 'lead-security', overlay: [
    '## Identity: Security lead',
    '',
    'You own the security posture: authn/authz, secrets handling, injection and',
    'traversal surfaces, dependency risk, and security review of changes.',
  ].join('\n') },
  { id: 'lead-network', overlay: [
    '## Identity: Network lead',
    '',
    'You own connectivity: protocols, remote integrations, service-to-service',
    'communication, and network-facing reliability.',
  ].join('\n') },
]

// NULL-only overlay stamp — module-local prepared statement (the domains.ts
// local-statement precedent). `identity_overlay IS NULL` is the whole guard:
// a customized OR ''-silenced row never matches.
const stampSeedOverlay = db.prepare(
  `UPDATE agent_profiles SET identity_overlay = ? WHERE id = ? AND identity_overlay IS NULL`,
)

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
  // L1.5 seed overlays (C.2, D-126): stamp NULL rows only — operator edits
  // (including '' = silenced) survive every re-seed. (chief + the five leads;
  // k-secretary's overlay is seeded by the A.5 reconcile below.)
  for (const seed of SEED_IDENTITY_OVERLAYS) stampSeedOverlay.run(seed.overlay, seed.id)
  // A.5 (D-126): one-shot upgrade of an EXISTING k-secretary row to the
  // primary-agent grant set (+ the identity-overlay seed). Fail-safe: a reconcile
  // failure must not abort boot — log and continue; the flag stays unset so the
  // next boot retries.
  try {
    reconcileKPrimaryAuthority()
  } catch (e) {
    console.warn('[profiles] K primary-authority reconcile failed (will retry next boot):', e)
  }
  return created
}

// ─── A.5: K primary-agent authority reconcile (D-126, one-shot) ──────────────

/** app_config flag for the one-shot K primary-authority reconcile. Set AFTER a
 *  successful reconcile, so an operator NARROWING made later is never re-widened. */
const K_PRIMARY_RECONCILE_FLAG = 'mig_k_primary_authority_v1'

/** The write-once k-secretary identity-overlay seed (L1.5, D-126). Applied
 *  only while the column is NULL — the operator's later edits win forever. */
export const K_IDENTITY_OVERLAY_SEED =
  'You are K — the operator\'s primary agent: a top-tier engineering agent and the expert on this ' +
  'harness (pipelines, runs, budgets, skills, artifacts). You read and analyze anything; you never ' +
  'mutate directly — real work is delegated to pipelines and orchestrators and supervised to completion.'

/** One-shot: widen an existing (pre-lane) k-secretary row to the primary-agent
 *  grant set — Read/Grep/Glob + the gitnexus mount — and seed the identity
 *  overlay. Fresh DBs get the new grants from the assets at createProfile time,
 *  so for them only the overlay seed does work. `updateProfile` re-runs
 *  assertEffectiveGrants against the NEW assets (this change ships with the
 *  widened allowlists/secretary.json, so the union is within the tier ceiling). */
function reconcileKPrimaryAuthority(): void {
  if (configDb.get(K_PRIMARY_RECONCILE_FLAG) != null) return
  // One transaction: grants + overlay + flag land (or roll back) together, so a
  // mid-apply failure can never leave the row widened with the flag unset — a
  // retry after an operator narrowing must not re-widen it.
  db.transaction(() => {
    const k = getProfile('k-secretary')
    if (k) {
      const tools = new Set(k.allowedTools)
      for (const t of ['Read', 'Grep', 'Glob', 'mcp__gitnexus']) tools.add(t)
      const servers = new Set(k.mcpServers)
      servers.add('gitnexus')
      updateProfile('k-secretary', { allowedTools: [...tools], mcpServers: [...servers] })
      // Write-once (only-if-NULL): never clobbers an operator-edited overlay.
      agentProfilesDb.setProfileIdentityOverlay.run(K_IDENTITY_OVERLAY_SEED, 'k-secretary')
    }
    configDb.set(K_PRIMARY_RECONCILE_FLAG, String(Date.now()))
  })()
}
