/**
 * resolveRunAssets — the MODEL-NEUTRAL run-asset resolution seam (A3: REAL).
 *
 * ONE interface, TWO consumers (host-integration plan, "ResolvedRunAssets"):
 *   - the Claude path: synthesizeConfigDir (agent-config.ts) IS resolveRunAssets +
 *     vendoring since wave A3 — every validation below is the validation a
 *     dispatch gets;
 *   - the Ollama tool-loop runtime (Lane B) consumes the SAME function.
 *
 * K-NATIVE semantics are byte-identical to the Wave-0 shim (itself an in-memory
 * extraction of the pre-D-069 synthesizeConfigDir): same bundle/template/
 * allowlist narrowing, same fail-closed GrantErrors, same run-scoped MCP
 * rewriting. The parity contract with the synthesizer's OUTPUT is locked by
 * test/run-assets-shim.test.ts.
 *
 * DISCOVERED assets (D-069/D-070) resolve through the same call:
 *   - profile.skills / profile.mcpServers may carry QUALIFIED KEYS (user:<n>,
 *     project:<id>:<n>, plugin:<p>@<m>:<n>) next to bare tier names;
 *   - admission is the SHARED authority.ts primitive set (resolveEffectiveCeiling
 *     + assertDiscoveredSkillGrant/assertDiscoveredServerGrant — the same checks
 *     the profile PATCH boundary runs, one source, no drift), resolved LAZILY so
 *     a pure k-native profile never touches the catalog db;
 *   - discovered MCP trust is RE-VERIFIED against the LIVE host config at resolve
 *     time (re-scan + re-hash vs the trusted pin; mismatch → GrantError,
 *     fail-closed — closes the rescan→dispatch TOCTOU window, D-070);
 *   - claude-project assets scoped to a DIFFERENT project are silently dropped
 *     from the mounts + logged (the F-068 narrowing precedent — dropping a mount
 *     is always safe);
 *   - mount-dir collisions (D-069): k-native wins the bare name; discovered
 *     mounts as `<name>--<sourceKind>`, with a short qualified-key hash suffix if
 *     still colliding;
 *   - assertMcpGrants runs over the FINAL post-filter union (D-034: every mounted
 *     server — tier or discovered — needs its mcp__<name> grant).
 *
 * Validation order (plan: ceiling → narrowing → discovered resolution → F-068
 * drop → project filter → assertMcpGrants): every check runs before anything is
 * returned; a rejected profile throws the typed GrantError (authority.ts) — the
 * signal PATCH routes map to a 400 and the supervisor surfaces as a failed run.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import type { SkillSourceKind } from '@k/shared'
import type { AgentProfile } from './profiles.js'
import { memoriesDb } from './db.js'
import {
  assertMcpGrants,
  computeDisallowedTools,
  toolWithinCeiling,
  resolveEffectiveCeiling,
  assertDiscoveredSkillGrant,
  assertDiscoveredServerGrant,
  GrantError,
  type EffectiveCeiling,
} from './authority.js'
import { assertSafeSegment, KNOWN_CHARTERS, resolveTsxLoader } from './agent-config.js'
import { assertSafeSkillKey, confineToRoots, resolveSkillRoots } from './skill-roots.js'
import {
  getCatalogSkillRow,
  getHostMcpServerRow,
  registeredProjects,
  scanHostMcpServers,
  type DiscoveredMcpServer,
  type ProjectRef,
} from './host-discovery.js'
import { estimateTokens } from './token-estimate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirrors agent-config.ts: repo-root agent-config/ and data/ defaults.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')
const DEFAULT_DATA_DIR = path.join(__dirname, '../../data')

// ─── the frozen seam types (plan: "ResolvedRunAssets") ───────────────────────

export interface ResolvedSkill {
  /** Canonical D-069 key. k-native: the bare skill name. */
  qualifiedKey: string
  name: string
  /** Directory name the skill mounts under in the run config (collision rule
   *  D-069: k-native wins the bare name; discovered gets `<name>--<sourceKind>`,
   *  plus a short key-hash suffix if still colliding). */
  mountDirName: string
  sourceKind: SkillSourceKind
  /** Absolute source dir the vendoring step copies from (read in place — no write here).
   *  For discovered rows this is the REALPATH the confinement gate approved. */
  srcDir: string
  /** The allowlisted root that confines `srcDir` — the copyDirConfined srcRoot.
   *  Present ONLY on discovered rows (k-native vendors via copyDirGuarded). */
  srcRoot?: string
  /** Estimated full-body tokens (k-native: live chars/4 over the SKILL.md files;
   *  discovered: the catalog row's est_tokens snapshot). */
  estTokens: number
}

export interface ResolvedMcpServer {
  name: string
  sourceKind: SkillSourceKind
  /** The exact server config a consumer launches/writes — run-scoped K servers
   *  (kstore/logistics/mgmt) arrive REWRITTEN (process.execPath + tsx loader in
   *  dev + K_DATA_DIR/K_RUN_ID env); gitnexus and DISCOVERED servers pass through
   *  verbatim (a discovered server NEVER gets K_DATA_DIR/K_RUN_ID injected). */
  config: { command: string; args: string[]; env: Record<string, string> }
  /** Estimated tool-definition tokens; null until probed (D-070). */
  estTokens: number | null
}

export interface ResolvedRunAssets {
  /** L0 base operating prompt + L1 tier charter — same layering/joiner as the synthesizer. */
  systemPrompt: string
  skills: ResolvedSkill[]
  mcpServers: ResolvedMcpServer[]
  allowedTools: string[]
  disallowedTools: string[]
  estTokens: {
    /** Always-loaded skill metadata cost (frontmatter, else name — chars/4). */
    skillsMeta: number
    /** On-invocation full-body cost (sum of skills[].estTokens). */
    skillsBodies: number
    /** MCP tool-definition cost: the sum of PROBED discovered-server estimates;
     *  null when nothing mounted carries an estimate (all k servers, unprobed). */
    mcpTools: number | null
  }
}

export interface ResolveRunAssetsOpts {
  runId: string
  /** Project scope for discovered-asset filtering (D-069): claude-project assets
   *  whose project_id ≠ this are silently dropped from the mounts + logged. */
  projectId?: string
  /** F-068: drop the gitnexus server for an external-target run (same drop the
   *  synthesizer applies — dropping a mount is always safe: fewer grants). */
  suppressGitnexus?: boolean
  assetsDir?: string
  dataDir?: string
  // ── TEST SEAMS (additive-optional; mirror agent-config.ts hostCredentialsPath
  //    and host-discovery.ts SyncHostDiscoveryOpts). Production callers omit them.
  /** Override the host claude home for skill-root confinement (default ~/.claude). */
  claudeHome?: string
  /** Override the live host config path for the D-070 trust re-verify (default ~/.claude.json). */
  claudeJsonPath?: string
  /** Override the registered-project set (default: the projects table). */
  projects?: ProjectRef[]
}

// ─── k-native skill token estimation (unchanged from the Wave-0 shim) ─────────

/** Every SKILL.md body under `srcDir` (recursive). A mounted skill dir may be a
 *  GROUP of nested skills (e.g. agent-config/skills/gitnexus/<sub>/SKILL.md with
 *  no top-level file), and all of those bodies are invocable once mounted — so
 *  the body estimate covers them all. Unreadable entries degrade to skipped
 *  (never throw). */
function readSkillBodies(srcDir: string): string[] {
  const bodies: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name === 'SKILL.md') {
        try {
          bodies.push(fs.readFileSync(p, 'utf8'))
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  walk(srcDir)
  return bodies
}

/** The always-loaded metadata slice of a skill body: its YAML frontmatter block
 *  (name+description live there) when present, else the fallback name. The
 *  cross-lane est_tokens_meta convention measures THIS slice. */
function skillMetaText(body: string, name: string): string {
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end > 0) return body.slice(0, end + 4)
  }
  return name
}

/** Short deterministic suffix for a mount-dir collision (D-069). */
function shortKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

// ─── the seam ─────────────────────────────────────────────────────────────────

/**
 * Resolve everything a run mounts, WITHOUT writing anything. Throws GrantError on
 * any profile-narrowing / admission / trust violation; plain Error for structural
 * faults (missing assets). See the module header for the full contract.
 */
export function resolveRunAssets(profile: AgentProfile, opts: ResolveRunAssetsOpts): ResolvedRunAssets {
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const dataDir = opts.dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR
  const charter = profile.charter

  // Same pre-flight as the synthesizer: reject traversal in the run id and the
  // tier asset name, and refuse a safe-but-unknown charter.
  assertSafeSegment(opts.runId, 'runId')
  assertSafeSegment(charter, 'charter')
  if (!KNOWN_CHARTERS.has(charter)) {
    throw new Error(`run-assets: unknown charter "${charter}" — not one of ${[...KNOWN_CHARTERS].join(', ')}`)
  }

  // The EFFECTIVE ceiling (tier assets ∪ admitted discovered assets) is resolved
  // LAZILY: a pure k-native profile — every existing dispatch — never touches the
  // catalog db and never re-reads the assets beyond what the shim read.
  let effectiveCeiling: EffectiveCeiling | null = null
  const ceiling = (): EffectiveCeiling => (effectiveCeiling ??= resolveEffectiveCeiling(charter, { assetsDir }))

  // ── Profile-row resolution + fail-closed validation (mirrors agent-config B1) ──

  // Skills: a non-empty profile.skills row narrows WITHIN the tier bundle for
  // BARE names (the bundle is the ceiling — fail-closed, byte-identical to the
  // shim); QUALIFIED keys go through the shared D-069 admission primitive.
  const bundlePath = path.join(assetsDir, 'bundles', `${charter}.json`)
  if (!fs.existsSync(bundlePath)) throw new Error(`run-assets: bundle for tier "${charter}" not found`)
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as { skills?: string[] }
  const bundleSkills = bundle.skills ?? []
  const usedProfileSkills = profile.skills.length > 0
  const skillsToMount = usedProfileSkills ? profile.skills : bundleSkills
  const bareSkills: string[] = []
  const discoveredSkillKeys: string[] = []
  for (const skill of skillsToMount) {
    if (skill.includes(':')) {
      // Qualified key — D-069 admission (tier opt-in + enabled + ok), fail-closed.
      assertDiscoveredSkillGrant(charter, ceiling(), skill)
      if (!discoveredSkillKeys.includes(skill)) discoveredSkillKeys.push(skill)
      continue
    }
    assertSafeSegment(skill, 'bundle skill')
    if (usedProfileSkills && !bundleSkills.includes(skill)) {
      throw new GrantError(
        `run-assets: profile skill "${skill}" is not in the "${charter}" tier bundle — the tier bundle is the ceiling`,
      )
    }
    bareSkills.push(skill)
  }

  // MCP servers: the tier template defines WHICH bare-named servers exist (the
  // ceiling); a bare name with no tier definition is fail-closed. QUALIFIED keys
  // go through the shared D-070 admission primitive (enabled + trusted + ok).
  // Template KEY ORDER is preserved through the filter so the mounted list
  // matches the synthesizer's mcp.json.
  const mcp = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'mcp', `${charter}.json`), 'utf8'),
  ) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }
  const tierServerKeys = Object.keys(mcp.mcpServers ?? {})
  const serversToMount = profile.mcpServers.length > 0 ? profile.mcpServers : tierServerKeys
  const bareServers: string[] = []
  const discoveredServerKeys: string[] = []
  for (const name of serversToMount) {
    if (name.includes(':')) {
      assertDiscoveredServerGrant(charter, ceiling(), name)
      if (!discoveredServerKeys.includes(name)) discoveredServerKeys.push(name)
      continue
    }
    if (!mcp.mcpServers?.[name]) {
      throw new GrantError(
        `run-assets: profile mounts MCP server "${name}" but tier "${charter}" defines no such server — unknown servers are fail-closed`,
      )
    }
    bareServers.push(name)
  }
  // F-068 gitnexus drop for external-target runs — same narrowing the synthesizer applied.
  const mountedServers = opts.suppressGitnexus ? bareServers.filter(name => name !== 'gitnexus') : bareServers
  const wantedServers = new Set(mountedServers)
  const mountedEntries = Object.entries(mcp.mcpServers ?? {}).filter(([k]) => wantedServers.has(k))

  // Allowed tools: a non-empty profile row is the operator's narrowed grant.
  // The TIER allowlist is checked FIRST (byte-identical fast path — no catalog
  // reads); only a tool above the tier ceiling consults the WIDENED effective
  // ceiling (D-070: mcp__<name> grants for admitted discovered servers).
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'allowlists', `${charter}.json`), 'utf8'),
  ) as { allowedTools: string[] }
  const allowedTools = profile.allowedTools.length > 0 ? profile.allowedTools : allowlist.allowedTools
  if (profile.allowedTools.length > 0) {
    const tierCeiling = new Set(allowlist.allowedTools)
    for (const tool of allowedTools) {
      if (toolWithinCeiling(tool, tierCeiling)) continue
      if (!toolWithinCeiling(tool, ceiling().allowedTools)) {
        throw new GrantError(
          `run-assets: profile tool "${tool}" exceeds the "${charter}" tier ceiling — the tier allowlist is the ceiling`,
        )
      }
    }
  }

  // ── Discovered SKILL resolution (D-069) ─────────────────────────────────────
  // Admission passed above; now: project-scope filter → confinement → mount name.
  const projects =
    opts.projects ?? (discoveredSkillKeys.length || discoveredServerKeys.length ? registeredProjects() : [])
  const projectRoots = new Map<string, string>()
  for (const p of projects) projectRoots.set(p.id, path.join(p.localPath, '.claude', 'skills'))
  const skillRoots = resolveSkillRoots({ claudeHome: opts.claudeHome, assetsDir, projectRoots })

  let discoveredMeta = 0
  const takenMounts = new Set(bareSkills) // k-native wins the bare name (D-069)
  const discoveredSkills: ResolvedSkill[] = []
  for (const key of discoveredSkillKeys) {
    const row = getCatalogSkillRow(key)
    if (!row) throw new Error(`run-assets: discovered skill "${key}" vanished from the catalog mid-resolve`)
    // Project-scope filter (F-068 precedent: dropping a mount is always safe).
    if (row.source_kind === 'claude-project' && String(row.project_id) !== opts.projectId) {
      console.warn(
        `[run-assets] discovered skill "${key}" is scoped to project ${String(row.project_id)} — dropped from this run's mounts (run target: ${opts.projectId ?? 'none'})`,
      )
      continue
    }
    // Confinement: the origin dir must sit under an allowlisted skill root
    // (string gate + realpath gate). A vanished or escaping origin is fail-closed.
    const originPath = String(row.origin_path ?? '')
    const confined = originPath ? confineToRoots(originPath, skillRoots) : null
    if (!confined) {
      throw new Error(
        `run-assets: discovered skill "${key}" origin "${originPath}" is missing or escapes the allowlisted skill roots — fail-closed (rescan to update the catalog)`,
      )
    }
    // Mount-dir collision rule (D-069): always `<name>--<sourceKind>`; a further
    // short key-hash suffix if still colliding (e.g. same name from two projects).
    const parsed = assertSafeSkillKey(key)
    let mountDirName = `${parsed.name}--${String(row.source_kind)}`
    if (takenMounts.has(mountDirName)) mountDirName = `${mountDirName}--${shortKeyHash(key)}`
    takenMounts.add(mountDirName)
    discoveredMeta += Number(row.est_tokens_meta ?? 0)
    discoveredSkills.push({
      qualifiedKey: key,
      name: String(row.name),
      mountDirName,
      sourceKind: row.source_kind as SkillSourceKind,
      srcDir: confined.real,
      srcRoot: confined.root,
      estTokens: Number(row.est_tokens ?? 0),
    })
  }

  // ── Discovered MCP resolution (D-070) ───────────────────────────────────────
  // Admission passed above; now: project-scope filter → LIVE trust re-verify →
  // name-collision guard. The live host config is scanned ONCE per resolve.
  let liveServers: Map<string, DiscoveredMcpServer> | null = null
  const liveServer = (key: string): DiscoveredMcpServer | undefined => {
    if (liveServers === null) {
      const claudeJsonPath = opts.claudeJsonPath ?? path.join(os.homedir(), '.claude.json')
      liveServers = new Map(scanHostMcpServers(claudeJsonPath, projects).items.map(i => [i.qualifiedKey, i]))
    }
    return liveServers.get(key)
  }
  const usedServerNames = new Set(mountedServers)
  const discoveredMcp: ResolvedMcpServer[] = []
  for (const key of discoveredServerKeys) {
    const row = getHostMcpServerRow(key)
    if (!row) throw new Error(`run-assets: discovered MCP server "${key}" vanished from the catalog mid-resolve`)
    if (row.source_kind === 'claude-project' && String(row.project_id) !== opts.projectId) {
      console.warn(
        `[run-assets] discovered MCP server "${key}" is scoped to project ${String(row.project_id)} — dropped from this run's mounts (run target: ${opts.projectId ?? 'none'})`,
      )
      continue
    }
    const name = String(row.name)
    // (A discovered server named gitnexus/kstore/logistics/mgmt never reaches
    // here — admission refuses K-reserved names unconditionally, which subsumes
    // the F-068 discovered-gitnexus concern: reserved impersonators THROW at
    // grant time rather than being dropped at dispatch.)
    // D-070 TOCTOU close: re-read the LIVE host config and re-hash — the config
    // a run will spawn must BYTE-MATCH what the operator trusted, right now.
    const live = liveServer(key)
    if (!live) {
      throw new GrantError(
        `run-assets: discovered MCP server "${key}" is no longer present in the live host config — fail-closed (rescan to update the catalog)`,
      )
    }
    if (row.trusted_hash == null || live.configHash !== row.trusted_hash) {
      throw new GrantError(
        `run-assets: discovered MCP server "${key}" live config does not match its trusted pin — fail-closed (the host config drifted since trust; rescan and re-trust)`,
      )
    }
    if (usedServerNames.has(name)) {
      throw new GrantError(
        `run-assets: discovered MCP server "${key}" mounts as "${name}", which collides with another mounted server — MCP mount keys must be unique (disable one, or rename it on the host)`,
      )
    }
    usedServerNames.add(name)
    discoveredMcp.push({
      name,
      sourceKind: row.source_kind as SkillSourceKind,
      // VERBATIM live config — no K_DATA_DIR/K_RUN_ID injection for host servers.
      config: { command: live.command, args: live.args, env: live.env },
      estTokens: row.est_tokens != null ? Number(row.est_tokens) : null,
    })
  }

  // Mounting ≠ granting (D-034) over the FINAL post-filter union: every mounted
  // server — tier (bare) or discovered (by NAME) — must be granted by the final
  // (possibly narrowed) allowlist. Throws GrantError.
  assertMcpGrants(profile.tier, allowedTools, [...mountedServers, ...discoveredMcp.map(s => s.name)])
  const disallowedTools = computeDisallowedTools(allowedTools)

  // ── System prompt: L0 base + L1 tier charter (same read + joiner as synth) ──
  const l0 = fs.readFileSync(path.join(assetsDir, 'base-operating-prompt.md'), 'utf8')
  const l1 = fs.readFileSync(path.join(assetsDir, 'tiers', `${charter}.charter.md`), 'utf8')
  let systemPrompt = `${l0}\n\n---\n\n${l1}`
  // L1.5 — per-profile identity overlay (D-126): appended VERBATIM when non-empty,
  // same joiner as L0/L1. Whitespace-only counts as empty so a stray newline saved
  // from a textarea can never change synthesis output (byte-locked:
  // identity-overlay.test.ts). Overlay content is operator-authored profile
  // config — the same trust class as charter assets. Write paths today are code
  // and seeds only; the bearer-authed, length-capped routes land with C.3.
  if (profile.identityOverlay != null && profile.identityOverlay.trim() !== '') {
    systemPrompt = `${systemPrompt}\n\n---\n\n${profile.identityOverlay}`
  }
  // Secretary-only L2 addendum: the operator's durable memories (saved via the
  // logistics `memory_save` tool), most-recently-updated first. Bounded at 4000
  // chars so an unbounded memory store can never blow out the prompt budget.
  if (charter === 'secretary') {
    const rows = memoriesDb.listRecentMemories.all(20) as Array<{ content: string }>
    if (rows.length) {
      const block = rows.map(r => `- ${r.content}`).join('\n').slice(0, 4000)
      systemPrompt = `${systemPrompt}\n\n---\n\n## What you remember about your operator\n\n${block}`
    }
  }

  // ── k-native skills: resolve in place from agent-config/skills/<name> ───────
  let skillsMeta = 0
  const skills: ResolvedSkill[] = bareSkills.map(skill => {
    const srcDir = path.join(assetsDir, 'skills', skill)
    // Same existence check (and message tail) the synthesizer's mount step applied.
    if (!fs.existsSync(srcDir)) throw new Error(`run-assets: bundle skill "${skill}" not found`)
    const bodies = readSkillBodies(srcDir)
    // Meta = the always-loaded slice: each nested SKILL.md's frontmatter (name +
    // description), or the bare skill name when the dir carries no SKILL.md.
    skillsMeta += bodies.length
      ? bodies.reduce((sum, b) => sum + estimateTokens(skillMetaText(b, skill)), 0)
      : estimateTokens(skill)
    return {
      qualifiedKey: skill, // k-native: the bare name IS the D-069 qualified key
      name: skill,
      mountDirName: skill, // k-native wins the bare mount name (D-069 collision rule)
      sourceKind: 'k' as const,
      srcDir,
      estTokens: bodies.reduce((sum, b) => sum + estimateTokens(b), 0),
    }
  })
  skillsMeta += discoveredMeta
  const allSkills = [...skills, ...discoveredSkills]
  const skillsBodies = allSkills.reduce((sum, s) => sum + s.estTokens, 0)

  // ── MCP: run-scoped K server rewriting, byte-faithful to the synthesizer ────
  // Each placeholder command/args becomes THIS core's server launch (dev runs the
  // .ts via the pinned tsx loader; a build runs the .js), and its env gains the
  // run's K_DATA_DIR / K_RUN_ID. Other tier servers (gitnexus) pass through
  // untouched. Discovered servers were resolved VERBATIM above.
  const runScopedServers = new Map<string, string>([
    ['kstore', 'k-store-server'],
    ['logistics', 'logistics-server'],
    ['mgmt', 'mgmt-server'],
  ])
  const ext = path.extname(fileURLToPath(import.meta.url)) // '.ts' under tsx, '.js' built
  const tierMcpServers: ResolvedMcpServer[] = mountedEntries.map(([name, srv]) => {
    const moduleBase = runScopedServers.get(name)
    if (moduleBase) {
      const serverPath = path.join(__dirname, 'mcp', `${moduleBase}${ext}`)
      if (!fs.existsSync(serverPath)) {
        throw new Error(`run-assets: ${name} server module not found at ${serverPath}`)
      }
      return {
        name,
        sourceKind: 'k' as const,
        config: {
          command: process.execPath,
          args: ext === '.ts' ? ['--import', resolveTsxLoader(), serverPath] : [serverPath],
          env: { ...(srv.env ?? {}), K_DATA_DIR: dataDir, K_RUN_ID: opts.runId },
        },
        estTokens: null,
      }
    }
    return {
      name,
      sourceKind: 'k' as const,
      config: { command: srv.command ?? '', args: srv.args ?? [], env: srv.env ?? {} },
      estTokens: null,
    }
  })
  const mcpServers = [...tierMcpServers, ...discoveredMcp]

  // mcpTools: the sum of known (probed) estimates; null when nothing carries one
  // (k servers are never probed — parity with the shim's always-null).
  const probed = discoveredMcp.filter(s => s.estTokens != null)
  const mcpTools = probed.length ? probed.reduce((sum, s) => sum + (s.estTokens ?? 0), 0) : null

  return {
    systemPrompt,
    skills: allSkills,
    mcpServers,
    allowedTools,
    disallowedTools,
    estTokens: { skillsMeta, skillsBodies, mcpTools },
  }
}
