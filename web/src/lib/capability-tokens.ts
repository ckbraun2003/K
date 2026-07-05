import type { AgentProfile, CatalogSkill, CatalogMcpServer } from '@k/shared'

// Pure token-accounting helpers for the capability catalog (D-069). All figures
// are ESTIMATES of prompt-context cost (chars/4 heuristic, ±25%) — never billed
// tokens. Entries with a null estTokens are EXCLUDED from every sum and counted
// as `unestimatedCount` instead, so a partially-probed catalog never reads as a
// falsely-precise total. Mirrors CapabilitySummarySchema's side shape.

/** One side (skills / mcp) of a token subtotal — the CapabilityStatRow unit. */
export interface TokenSide {
  /** How many entries are in the summed set. */
  enabledCount: number
  /** Σ estTokens over the set's MEASURED entries only. */
  estTokens: number
  /** Entries in the set with estTokens === null (excluded from the sum). */
  unestimatedCount: number
}

function sumSide(entries: ReadonlyArray<{ estTokens: number | null }>): TokenSide {
  let estTokens = 0
  let unestimatedCount = 0
  for (const e of entries) {
    if (e.estTokens === null) unestimatedCount += 1
    else estTokens += e.estTokens
  }
  return { enabledCount: entries.length, estTokens, unestimatedCount }
}

/** Token subtotal over the ENABLED skills in the catalog. */
export function enabledSkillTokens(skills: ReadonlyArray<CatalogSkill>): TokenSide {
  return sumSide(skills.filter(s => s.enabled))
}

/** Token subtotal over the ENABLED MCP servers in the catalog. */
export function enabledMcpTokens(servers: ReadonlyArray<CatalogMcpServer>): TokenSide {
  return sumSide(servers.filter(s => s.enabled))
}

/** A profile's per-mount token subtotal (the CapabilityPicker footer). */
export interface ProfileSubtotal {
  skills: TokenSide
  mcp: TokenSide
  /** skills.estTokens + mcp.estTokens — the profile's context-overhead estimate. */
  totalEstTokens: number
  /** unmeasured skills + servers (excluded from the total, footnoted in the UI). */
  unestimatedCount: number
  /** Profile entries with NO matching catalog row (by qualified key). Excluded
   *  from every figure and surfaced as chips — the catalog can't price what it
   *  can't see (e.g. an entry from before discovery, or a deregistered asset). */
  notInCatalog: string[]
}

/**
 * Token subtotal for ONE profile's mounted skills/servers, resolved against the
 * catalog by qualified key (catalog `id` — bare name for k-native entries).
 * Mounted-but-unknown entries land in `notInCatalog`, never in the sums.
 */
export function profileSubtotal(
  profile: Pick<AgentProfile, 'skills' | 'mcpServers'>,
  skills: ReadonlyArray<CatalogSkill>,
  servers: ReadonlyArray<CatalogMcpServer>,
): ProfileSubtotal {
  const skillById = new Map(skills.map(s => [s.id, s]))
  const serverById = new Map(servers.map(s => [s.id, s]))

  const notInCatalog: string[] = []
  const mountedSkills: CatalogSkill[] = []
  for (const key of profile.skills) {
    const hit = skillById.get(key)
    if (hit) mountedSkills.push(hit)
    else notInCatalog.push(key)
  }
  const mountedServers: CatalogMcpServer[] = []
  for (const key of profile.mcpServers) {
    const hit = serverById.get(key)
    if (hit) mountedServers.push(hit)
    else notInCatalog.push(key)
  }

  const skillSide = sumSide(mountedSkills)
  const mcpSide = sumSide(mountedServers)
  return {
    skills: skillSide,
    mcp: mcpSide,
    totalEstTokens: skillSide.estTokens + mcpSide.estTokens,
    unestimatedCount: skillSide.unestimatedCount + mcpSide.unestimatedCount,
    notInCatalog,
  }
}
