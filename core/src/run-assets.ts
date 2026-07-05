/**
 * resolveRunAssets — the MODEL-NEUTRAL run-asset resolution seam (Wave 0 SHIM).
 *
 * ONE interface, TWO consumers (host-integration plan, "ResolvedRunAssets"):
 *   - the Claude path: synthesizeConfigDir will become resolveRunAssets +
 *     vendoring (Lane A wave A3 — NOT this wave; agent-config.ts is untouched);
 *   - the Ollama tool-loop runtime (Lane B) consumes the SAME function from
 *     day 1 — that lane builds against THIS shim.
 *
 * SHIM STATUS (read this before extending):
 *   This is an IN-MEMORY extraction of today's synthesizeConfigDir semantics
 *   (agent-config.ts:253-501) for K-NATIVE assets only. It performs NO
 *   filesystem writes — it resolves and validates exactly what a run would
 *   mount, using the same assets, the same fail-closed narrowing checks, and
 *   the same run-scoped MCP rewriting, then RETURNS the result instead of
 *   materializing a config dir. The parity contract is locked by
 *   test/run-assets-shim.test.ts (shim output ≡ synthesizeConfigDir output).
 *
 *   TODO (Lane A — discovered assets): resolution of DISCOVERED skills/servers
 *   (qualified keys via skill-roots.ts confineToRoots, enabled+ok+trust-hash
 *   gating, resolveEffectiveCeiling, project-scope filtering with `projectId`)
 *   lands here in Lane A. `opts.projectId` is accepted now so the signature is
 *   frozen, and is deliberately UNUSED by the shim.
 *
 * Validation order mirrors the synthesizer's validate-before-mutate discipline:
 * every check runs before anything is returned, and a rejected profile throws
 * the typed GrantError (authority.ts) — the signal PATCH routes map to a 400.
 * NOTE: synthesizeConfigDir throws plain Error for the same three narrowing
 * violations; this seam standardizes on GrantError (same messages) per the
 * D-054 fail-closed posture. A3 aligns the synthesizer when it swaps onto this
 * function.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { SkillSourceKind } from '@k/shared'
import type { AgentProfile } from './profiles.js'
import { assertMcpGrants, computeDisallowedTools, toolWithinCeiling, GrantError } from './authority.js'
import { assertSafeSegment, KNOWN_CHARTERS, resolveTsxLoader } from './agent-config.js'
import { estimateTokens } from './token-estimate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirrors agent-config.ts: repo-root agent-config/ and data/ defaults.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')
const DEFAULT_DATA_DIR = path.join(__dirname, '../../data')

// ─── the frozen seam types (plan: "ResolvedRunAssets") ───────────────────────

export interface ResolvedSkill {
  /** Canonical D-069 key. k-native (shim): the bare skill name. */
  qualifiedKey: string
  name: string
  /** Directory name the skill mounts under in the run config (collision rule
   *  D-069: k-native wins the bare name; discovered gets `<name>--<sourceKind>`).
   *  Shim (k-native only): === name. */
  mountDirName: string
  sourceKind: SkillSourceKind
  /** Absolute source dir the vendoring step copies from (read in place — no write here). */
  srcDir: string
  /** Estimated full-body tokens (SKILL.md, chars/4 — token-estimate.ts). */
  estTokens: number
}

export interface ResolvedMcpServer {
  name: string
  sourceKind: SkillSourceKind
  /** The exact server config a consumer launches/writes — run-scoped K servers
   *  (kstore/logistics/mgmt) arrive REWRITTEN (process.execPath + tsx loader in
   *  dev + K_DATA_DIR/K_RUN_ID env), others pass through verbatim. */
  config: { command: string; args: string[]; env: Record<string, string> }
  /** Estimated tool-definition tokens; null until probed (D-070) — always null in the shim. */
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
    /** MCP tool-definition cost; null = not probed (always null in the shim). */
    mcpTools: number | null
  }
}

export interface ResolveRunAssetsOpts {
  runId: string
  /** Project scope for discovered-asset filtering — accepted (frozen signature),
   *  UNUSED by the shim (see the Lane-A TODO in the header). */
  projectId?: string
  /** F-068: drop the gitnexus server for an external-target run (same drop the
   *  synthesizer applies — dropping a mount is always safe: fewer grants). */
  suppressGitnexus?: boolean
  assetsDir?: string
  dataDir?: string
}

// ─── skill token estimation (shim-local; Lane A replaces with DB-backed est_*) ─

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
 *  (name+description live there) when present, else the fallback name. */
function skillMetaText(body: string, name: string): string {
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end > 0) return body.slice(0, end + 4)
  }
  return name
}

// ─── the seam ─────────────────────────────────────────────────────────────────

/**
 * Resolve everything a run mounts, WITHOUT writing anything. Same inputs, same
 * assets, same fail-closed checks as synthesizeConfigDir; see the header for
 * shim scope. Throws GrantError on any profile-narrowing violation.
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

  // ── Profile-row resolution + fail-closed validation (mirrors agent-config B1) ──

  // Skills: a non-empty profile.skills row narrows WITHIN the tier bundle (the
  // bundle is the ceiling — fail-closed).
  const bundlePath = path.join(assetsDir, 'bundles', `${charter}.json`)
  if (!fs.existsSync(bundlePath)) throw new Error(`run-assets: bundle for tier "${charter}" not found`)
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as { skills?: string[] }
  const bundleSkills = bundle.skills ?? []
  const usedProfileSkills = profile.skills.length > 0
  const skillsToMount = usedProfileSkills ? profile.skills : bundleSkills
  for (const skill of skillsToMount) {
    assertSafeSegment(skill, 'bundle skill')
    if (usedProfileSkills && !bundleSkills.includes(skill)) {
      throw new GrantError(
        `run-assets: profile skill "${skill}" is not in the "${charter}" tier bundle — the tier bundle is the ceiling`,
      )
    }
  }

  // MCP servers: the tier template defines WHICH servers exist (the ceiling); a
  // name with no tier definition is fail-closed. Template KEY ORDER is preserved
  // through the filter so the mounted list matches the synthesizer's mcp.json.
  const mcp = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'mcp', `${charter}.json`), 'utf8'),
  ) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }
  const tierServerKeys = Object.keys(mcp.mcpServers ?? {})
  const serversToMount = profile.mcpServers.length > 0 ? profile.mcpServers : tierServerKeys
  for (const name of serversToMount) {
    if (!mcp.mcpServers?.[name]) {
      throw new GrantError(
        `run-assets: profile mounts MCP server "${name}" but tier "${charter}" defines no such server — unknown servers are fail-closed`,
      )
    }
  }
  // F-068 gitnexus drop for external-target runs — same narrowing the synthesizer applies.
  const mountedServers = opts.suppressGitnexus
    ? serversToMount.filter(name => name !== 'gitnexus')
    : serversToMount
  const wantedServers = new Set(mountedServers)
  const mountedEntries = Object.entries(mcp.mcpServers ?? {}).filter(([k]) => wantedServers.has(k))

  // Allowed tools: a non-empty profile row is the operator's narrowed grant,
  // enforced against the tier allowlist as the ceiling (toolWithinCeiling).
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'allowlists', `${charter}.json`), 'utf8'),
  ) as { allowedTools: string[] }
  const allowedTools = profile.allowedTools.length > 0 ? profile.allowedTools : allowlist.allowedTools
  if (profile.allowedTools.length > 0) {
    const ceiling = new Set(allowlist.allowedTools)
    for (const tool of allowedTools) {
      if (!toolWithinCeiling(tool, ceiling)) {
        throw new GrantError(
          `run-assets: profile tool "${tool}" exceeds the "${charter}" tier ceiling — the tier allowlist is the ceiling`,
        )
      }
    }
  }
  // Mounting ≠ granting (D-034): every mounted server must be granted by the
  // FINAL (possibly narrowed) allowlist. Throws GrantError.
  assertMcpGrants(profile.tier, allowedTools, mountedServers)
  const disallowedTools = computeDisallowedTools(allowedTools)

  // ── System prompt: L0 base + L1 tier charter (same read + joiner as synth) ──
  const l0 = fs.readFileSync(path.join(assetsDir, 'base-operating-prompt.md'), 'utf8')
  const l1 = fs.readFileSync(path.join(assetsDir, 'tiers', `${charter}.charter.md`), 'utf8')
  const systemPrompt = `${l0}\n\n---\n\n${l1}`

  // ── Skills: resolve in place from agent-config/skills/<name> (no copy) ──────
  let skillsMeta = 0
  const skills: ResolvedSkill[] = skillsToMount.map(skill => {
    const srcDir = path.join(assetsDir, 'skills', skill)
    // Same existence check (and message tail) the synthesizer's mount step applies.
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
  const skillsBodies = skills.reduce((sum, s) => sum + s.estTokens, 0)

  // ── MCP: run-scoped K server rewriting, byte-faithful to the synthesizer ────
  // Each placeholder command/args becomes THIS core's server launch (dev runs the
  // .ts via the pinned tsx loader; a build runs the .js), and its env gains the
  // run's K_DATA_DIR / K_RUN_ID. Other servers (gitnexus) pass through untouched.
  const runScopedServers = new Map<string, string>([
    ['kstore', 'k-store-server'],
    ['logistics', 'logistics-server'],
    ['mgmt', 'mgmt-server'],
  ])
  const ext = path.extname(fileURLToPath(import.meta.url)) // '.ts' under tsx, '.js' built
  const mcpServers: ResolvedMcpServer[] = mountedEntries.map(([name, srv]) => {
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

  return {
    systemPrompt,
    skills,
    mcpServers,
    allowedTools,
    disallowedTools,
    estTokens: { skillsMeta, skillsBodies, mcpTools: null },
  }
}
