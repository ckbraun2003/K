/**
 * Host discovery — the D-069/D-070 guarded scan of the Claude host layer.
 *
 * Four scanners (all PURE reads — no db, injectable roots) + one transactional
 * sync:
 *   - scanUserSkills(claudeHome)          → ~/.claude/skills/*  (depth ≤ 2)
 *   - scanProjectSkills(projects)         → <localPath>/.claude/skills/* per
 *                                           REGISTERED project (depth ≤ 2)
 *   - scanPluginSkills(claudeHome)        → installed_plugins.json (v2, the
 *                                           AUTHORITATIVE index) → <installPath>/skills/*;
 *                                           installPath realpath-VERIFIED under
 *                                           ~/.claude/plugins/cache (a poisoned
 *                                           index must not point discovery at
 *                                           arbitrary disk); version≠2 → guarded
 *                                           cache glob (temp_git_* junk skipped)
 *   - scanHostMcpServers(claudeJsonPath, projects)
 *                                         → ~/.claude.json user scope +
 *                                           projects[<path>].mcpServers (matched to
 *                                           registered projects, case-insensitive on
 *                                           win32) + <localPath>/.mcp.json
 *   - syncHostDiscovery(opts)             → ONE db.transaction upserting the skills
 *                                           catalog + host_mcp_servers, preserving
 *                                           the K-scoped enable OVERLAY, flagging
 *                                           vanished assets status='missing', and
 *                                           auto-disabling trust on MCP config drift.
 *
 * FAILURE POSTURE: a scanner never throws for a malformed host artifact — every
 * skip lands a structured CatalogWarning ({path, message}; the source + reason are
 * encoded in the message because the Wave-0 wire contract is frozen to that shape).
 * Discovered assets ALWAYS land default-disabled (enabled=0); rescan NEVER touches
 * the enabled overlay (D-069 — K never mutates host files, and the operator's
 * enablement survives every rescan).
 *
 * Prepared statements are owned HERE (the skills.ts::patchSkillRunId /
 * k-thread.ts module-scope-prepare precedent) rather than in db.ts, so the
 * catalog surface stays out of the shared accumulation file.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type DatabaseType from 'better-sqlite3'
import { RescanResultSchema, type CatalogWarning, type RescanResult, type SkillSourceKind } from '@k/shared'
import { db, projectsDb, configDb, agentProfilesDb, rowToAgentProfile } from './db.js'
import { assertSafeSkillKey } from './skill-roots.js'
import { estimateTokens } from './token-estimate.js'
import { isPathWithin } from './paths.js'

// ─── discovered shapes ────────────────────────────────────────────────────────

/** A skill found on the host — a METADATA SNAPSHOT (content stays on host disk;
 *  runs vendor-copy it at synth time, never read it live — D-069). */
export interface DiscoveredSkill {
  /** Canonical D-069 key (user:<name> | project:<id>:<name> | plugin:<p>@<m>:<name>). */
  qualifiedKey: string
  /** Display name: frontmatter `name`, else the skill dir name. The KEY always
   *  uses the dir name (the filesystem identity a mount resolves). */
  name: string
  description: string
  sourceKind: Exclude<SkillSourceKind, 'k'>
  /** Absolute skill DIRECTORY (contains SKILL.md) — the vendoring source. */
  originPath: string
  projectId: string | null
  pluginId: string | null
  pluginVersion: string | null
  /** sha256 hex of the SKILL.md bytes. */
  contentHash: string
  /** chars/4 estimate of the full SKILL.md body (on-invocation cost). */
  estTokens: number
  /** chars/4 estimate of name+description (the always-loaded cost). */
  estTokensMeta: number
}

/** A stdio MCP server found in the host config layer (D-070). Env VALUES are
 *  stored in core's db and NEVER leave core via any API payload. */
export interface DiscoveredMcpServer {
  qualifiedKey: string
  name: string
  sourceKind: 'claude-user' | 'claude-project'
  projectId: string | null
  command: string
  args: string[]
  env: Record<string, string>
  /** sha256 of the canonical {command,args,env} JSON — the trust-pin target. */
  configHash: string
}

export interface ScanResult<T> {
  items: T[]
  warnings: CatalogWarning[]
}

export interface ProjectRef {
  id: string
  localPath: string
}

// ─── shared helpers ───────────────────────────────────────────────────────────

/** Cap on how much of a SKILL.md head is searched for the closing frontmatter
 *  fence — a malformed giant file can't make the parser scan unbounded text. */
const FRONTMATTER_CAP = 8 * 1024

/**
 * Minimal, TOLERANT frontmatter reader: the file must start with `---`; the block
 * runs to the next line starting `---` (searched within the first 8 KB); only
 * single-line `name:` / `description:` entries are read (quoted values unwrapped).
 * Anything malformed → `{}` — the caller defaults name to the dir name and
 * description to ''. Never throws.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {}
  const head = text.slice(0, FRONTMATTER_CAP)
  const close = head.indexOf('\n---', 3)
  if (close < 0) return {}
  const out: { name?: string; description?: string } = {}
  for (const rawLine of head.slice(3, close).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = /^(name|description):\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    // Unwrap one matching pair of surrounding quotes (tolerant, not a YAML parser).
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (m[1] === 'name' && out.name === undefined) out.name = value
    if (m[1] === 'description' && out.description === undefined) out.description = value
  }
  return out
}

/** sha256 hex of `text`. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The canonical config hash for an MCP server definition (D-070 trust pin):
 * sha256 of the JSON of {command, args, env} with env keys SORTED, so key order
 * in the host file never fakes a drift. Exported — the A3 synth re-verify re-reads
 * the live host config and re-hashes with THIS function (one hash, no drift).
 */
export function canonicalMcpConfigHash(command: string, args: string[], env: Record<string, string>): string {
  const canonical = JSON.stringify({
    command,
    args,
    env: Object.fromEntries(Object.keys(env).sort().map(k => [k, env[k]])),
  })
  return sha256(canonical)
}

/** Probe `dir`/SKILL.md with lstat: a SYMLINKED or otherwise-irregular SKILL.md is
 *  skipped with a warning (never followed — F-069 posture); no entry at all →
 *  'none' (the caller may recurse one level). */
function probeSkillMd(
  dir: string,
  source: string,
  warnings: CatalogWarning[],
): { kind: 'none' } | { kind: 'skipped' } | { kind: 'ok'; content: string } {
  const mdPath = path.join(dir, 'SKILL.md')
  let st: fs.Stats
  try {
    st = fs.lstatSync(mdPath)
  } catch {
    return { kind: 'none' }
  }
  if (st.isSymbolicLink()) {
    warnings.push({ path: mdPath, message: `[${source}] symlinked SKILL.md skipped — symlinks are never followed at discovery` })
    return { kind: 'skipped' }
  }
  if (!st.isFile()) {
    warnings.push({ path: mdPath, message: `[${source}] SKILL.md is not a regular file — skipped` })
    return { kind: 'skipped' }
  }
  try {
    return { kind: 'ok', content: fs.readFileSync(mdPath, 'utf8') }
  } catch (e) {
    warnings.push({ path: mdPath, message: `[${source}] unreadable SKILL.md — skipped (${(e as Error).message})` })
    return { kind: 'skipped' }
  }
}

interface ScanRootOpts {
  sourceKind: Exclude<SkillSourceKind, 'k'>
  /** Build the qualified key for a dir name — validated via assertSafeSkillKey. */
  makeKey: (dirName: string) => string
  /** Human source label for warning messages ('claude-user', 'claude-plugin', …). */
  source: string
  projectId?: string | null
  pluginId?: string | null
  pluginVersion?: string | null
  /** Recurse ONE extra level into a first-level dir with no SKILL.md (the
   *  skill-group layout, e.g. skills/gitnexus/<sub>/SKILL.md). Plugins use the
   *  fixed skills/<name>/SKILL.md layout → false. */
  nested: boolean
}

/** List `dir`'s child directories (Dirents). ENOENT → empty WITHOUT warning (a
 *  host with no skills dir is normal); any other failure → warning + empty. */
function listChildDirs(dir: string, source: string, warnings: CatalogWarning[]): fs.Dirent[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push({ path: dir, message: `[${source}] unreadable directory — skipped (${(e as Error).message})` })
    }
    return []
  }
  return entries.filter(d => d.isDirectory() || d.isSymbolicLink())
}

/**
 * Scan one skills root (first-level dirs; one extra level when `nested` and the
 * first level has no SKILL.md; depth ≤ 2). Fail-closed choices:
 *   - a SYMLINKED child dir is skipped with a warning (its content would live
 *     outside the root — vendoring would refuse it anyway; refusing at discovery
 *     keeps the catalog honest);
 *   - a dir name that can't form a valid qualified key (grammar in skill-roots.ts)
 *     is skipped with a warning;
 *   - duplicate keys within one scan (nested name collisions) — first wins, warning.
 */
function scanSkillsRoot(
  root: string,
  opts: ScanRootOpts,
  out: DiscoveredSkill[],
  seen: Set<string>,
  warnings: CatalogWarning[],
): void {
  const collect = (dir: fs.Dirent, parent: string, allowRecurse: boolean): void => {
    const dirPath = path.join(parent, dir.name)
    if (dir.isSymbolicLink()) {
      warnings.push({ path: dirPath, message: `[${opts.source}] symlinked skill directory skipped — symlinks are never followed at discovery` })
      return
    }
    const probe = probeSkillMd(dirPath, opts.source, warnings)
    if (probe.kind === 'skipped') return
    if (probe.kind === 'none') {
      if (allowRecurse) {
        for (const child of listChildDirs(dirPath, opts.source, warnings)) collect(child, dirPath, false)
      }
      return
    }
    const key = opts.makeKey(dir.name)
    try {
      assertSafeSkillKey(key)
    } catch (e) {
      warnings.push({ path: dirPath, message: `[${opts.source}] skill name unusable as a catalog key — skipped (${(e as Error).message})` })
      return
    }
    if (seen.has(key)) {
      warnings.push({ path: dirPath, message: `[${opts.source}] duplicate skill key "${key}" — first discovery wins, this one skipped` })
      return
    }
    seen.add(key)
    const fm = parseSkillFrontmatter(probe.content)
    const name = fm.name?.trim() ? fm.name.trim() : dir.name
    const description = fm.description ?? ''
    out.push({
      qualifiedKey: key,
      name,
      description,
      sourceKind: opts.sourceKind,
      originPath: dirPath,
      projectId: opts.projectId ?? null,
      pluginId: opts.pluginId ?? null,
      pluginVersion: opts.pluginVersion ?? null,
      contentHash: sha256(probe.content),
      estTokens: estimateTokens(probe.content),
      estTokensMeta: estimateTokens(`${name}: ${description}`),
    })
  }
  for (const child of listChildDirs(root, opts.source, warnings)) collect(child, root, opts.nested)
}

// ─── scanners ─────────────────────────────────────────────────────────────────

/** Host USER skills: first-level dirs of <claudeHome>/skills with a regular-file
 *  SKILL.md; one extra level for skill groups; depth ≤ 2. */
export function scanUserSkills(claudeHome: string): ScanResult<DiscoveredSkill> {
  const items: DiscoveredSkill[] = []
  const warnings: CatalogWarning[] = []
  scanSkillsRoot(
    path.join(claudeHome, 'skills'),
    { sourceKind: 'claude-user', makeKey: n => `user:${n}`, source: 'claude-user', nested: true },
    items,
    new Set(),
    warnings,
  )
  return { items, warnings }
}

/** Per-REGISTERED-project skills: <localPath>/.claude/skills. A project without
 *  the dir contributes nothing — silently (most projects have no skills). */
export function scanProjectSkills(projects: ProjectRef[]): ScanResult<DiscoveredSkill> {
  const items: DiscoveredSkill[] = []
  const warnings: CatalogWarning[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    scanSkillsRoot(
      path.join(project.localPath, '.claude', 'skills'),
      {
        sourceKind: 'claude-project',
        makeKey: n => `project:${project.id}:${n}`,
        source: 'claude-project',
        projectId: project.id,
        nested: true,
      },
      items,
      seen,
      warnings,
    )
  }
  return { items, warnings }
}

/**
 * Plugin skills. `installed_plugins.json` (version 2) is the AUTHORITATIVE index —
 * the cache is never globbed blindly while the index is usable (it contains
 * temp_git_* junk, and `version` can be 'unknown'). Every installPath must
 * REALPATH-resolve under <claudeHome>/plugins/cache before its skills/ dir is
 * scanned: a poisoned index must not point discovery at arbitrary disk. An
 * unusable index (version ≠ 2, unparseable) degrades to a GUARDED cache glob
 * (cache/<marketplace>/<plugin>/<version>/skills/*, temp_git_*+dotdirs skipped).
 */
export function scanPluginSkills(claudeHome: string): ScanResult<DiscoveredSkill> {
  const items: DiscoveredSkill[] = []
  const warnings: CatalogWarning[] = []
  const seen = new Set<string>()
  const cacheRoot = path.join(claudeHome, 'plugins', 'cache')
  const indexPath = path.join(claudeHome, 'plugins', 'installed_plugins.json')

  const scanInstall = (installDir: string, pluginId: string, pluginVersion: string | null): void => {
    scanSkillsRoot(
      path.join(installDir, 'skills'),
      {
        sourceKind: 'claude-plugin',
        makeKey: n => `plugin:${pluginId}:${n}`,
        source: 'claude-plugin',
        pluginId,
        pluginVersion,
        nested: false,
      },
      items,
      seen,
      warnings,
    )
  }

  /** Fallback when the index is unusable: walk cache/<marketplace>/<plugin>/<version>,
   *  skipping temp_git_* clone junk and dot-dirs at every level. */
  const guardedGlob = (): void => {
    const junk = (n: string): boolean => n.startsWith('temp_git_') || n.startsWith('.')
    for (const marketplace of listChildDirs(cacheRoot, 'claude-plugin', warnings)) {
      if (junk(marketplace.name) || marketplace.isSymbolicLink()) continue
      const marketDir = path.join(cacheRoot, marketplace.name)
      for (const plugin of listChildDirs(marketDir, 'claude-plugin', warnings)) {
        if (junk(plugin.name) || plugin.isSymbolicLink()) continue
        const pluginDir = path.join(marketDir, plugin.name)
        for (const version of listChildDirs(pluginDir, 'claude-plugin', warnings)) {
          if (junk(version.name) || version.isSymbolicLink()) continue
          scanInstall(path.join(pluginDir, version.name), `${plugin.name}@${marketplace.name}`, version.name)
        }
      }
    }
  }

  let raw: string
  try {
    raw = fs.readFileSync(indexPath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { items, warnings } // no plugins installed — normal
    warnings.push({ path: indexPath, message: `[claude-plugin] unreadable installed_plugins.json — falling back to guarded cache glob (${(e as Error).message})` })
    guardedGlob()
    return { items, warnings }
  }

  let index: { version?: unknown; plugins?: Record<string, unknown> }
  try {
    index = JSON.parse(raw) as typeof index
  } catch (e) {
    warnings.push({ path: indexPath, message: `[claude-plugin] unparseable installed_plugins.json — falling back to guarded cache glob (${(e as Error).message})` })
    guardedGlob()
    return { items, warnings }
  }
  if (index.version !== 2 || typeof index.plugins !== 'object' || index.plugins === null) {
    warnings.push({ path: indexPath, message: `[claude-plugin] unsupported installed_plugins.json version ${JSON.stringify(index.version)} — falling back to guarded cache glob` })
    guardedGlob()
    return { items, warnings }
  }

  // realpath the cache root ONCE; if it can't resolve (no cache dir), no
  // installPath can verify — each install then warns individually below.
  let realCache: string | null = null
  try {
    realCache = fs.realpathSync(cacheRoot)
  } catch {
    realCache = null
  }

  for (const [pluginId, installsRaw] of Object.entries(index.plugins)) {
    const installs = Array.isArray(installsRaw) ? installsRaw : []
    for (const entry of installs) {
      const install = (entry ?? {}) as { installPath?: unknown; version?: unknown }
      if (typeof install.installPath !== 'string' || install.installPath.length === 0) {
        warnings.push({ path: indexPath, message: `[claude-plugin] plugin "${pluginId}" install entry has no installPath — skipped` })
        continue
      }
      // Containment gate: the REAL installPath must live under the REAL cache root.
      let realInstall: string
      try {
        realInstall = fs.realpathSync(install.installPath)
      } catch {
        warnings.push({ path: install.installPath, message: `[claude-plugin] plugin "${pluginId}" installPath does not resolve on disk — skipped` })
        continue
      }
      if (realCache === null || !isPathWithin(realCache, realInstall)) {
        warnings.push({ path: install.installPath, message: `[claude-plugin] plugin "${pluginId}" installPath resolves OUTSIDE the plugin cache — refused (poisoned index?)` })
        continue
      }
      scanInstall(realInstall, pluginId, typeof install.version === 'string' ? install.version : null)
    }
  }
  return { items, warnings }
}

/** Resolve + case-fold a project path for matching: the SAME registered project
 *  appears under multiple path-CASE variants in real ~/.claude.json files on
 *  Windows, so win32 comparison is case-insensitive. */
function normalizeProjectPath(p: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(p)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface ScanHostMcpOpts {
  /** Injectable for tests — win32 project-path matching is case-insensitive. */
  platform?: NodeJS.Platform
}

/**
 * Host MCP servers (D-070). User scope = top-level `mcpServers` of ~/.claude.json;
 * project scope = `projects[<path>].mcpServers` (matched to REGISTERED projects via
 * path.resolve + case-insensitive compare on win32) and `<localPath>/.mcp.json`.
 * `.mcp.json` is read FIRST so a ~/.claude.json project entry (Claude's local
 * scope, which outranks the shared file) wins the dedup; every overwrite —
 * including case-variant duplicate project keys — is last-write-wins WITH a
 * warning. Non-stdio (sse/http/url-typed) servers are skipped with a warning (v1).
 */
export function scanHostMcpServers(
  claudeJsonPath: string,
  projects: ProjectRef[],
  opts: ScanHostMcpOpts = {},
): ScanResult<DiscoveredMcpServer> {
  const platform = opts.platform ?? process.platform
  const warnings: CatalogWarning[] = []
  const byKey = new Map<string, DiscoveredMcpServer>()

  const addServer = (
    name: string,
    cfgRaw: unknown,
    sourceKind: 'claude-user' | 'claude-project',
    projectId: string | null,
    originPath: string,
  ): void => {
    const cfg = (cfgRaw ?? {}) as Record<string, unknown>
    // v1 scope: stdio only. A `type` of sse/http — or any `url`-shaped server — is
    // out of scope (spawning is the trust surface we gate; remote transports are not).
    const type = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : null
    if ((type !== null && type !== 'stdio') || typeof cfg.url === 'string') {
      warnings.push({ path: originPath, message: `[${sourceKind}] MCP server "${name}" is not stdio (type=${type ?? 'url'}) — skipped in v1` })
      return
    }
    if (typeof cfg.command !== 'string' || cfg.command.length === 0) {
      warnings.push({ path: originPath, message: `[${sourceKind}] MCP server "${name}" has no command — skipped` })
      return
    }
    const argsRaw = cfg.args ?? []
    if (!Array.isArray(argsRaw) || argsRaw.some(a => typeof a !== 'string')) {
      warnings.push({ path: originPath, message: `[${sourceKind}] MCP server "${name}" has malformed args — skipped` })
      return
    }
    const envRaw = cfg.env ?? {}
    if (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw)) {
      warnings.push({ path: originPath, message: `[${sourceKind}] MCP server "${name}" has malformed env — skipped` })
      return
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
      env[k] = typeof v === 'string' ? v : String(v)
    }
    const key = projectId === null ? `user:${name}` : `project:${projectId}:${name}`
    try {
      assertSafeSkillKey(key) // same one canonical key grammar (skill-roots.ts)
    } catch (e) {
      warnings.push({ path: originPath, message: `[${sourceKind}] MCP server name "${name}" unusable as a catalog key — skipped (${(e as Error).message})` })
      return
    }
    if (byKey.has(key)) {
      warnings.push({ path: originPath, message: `[${sourceKind}] duplicate MCP server definition "${key}" — last write wins` })
    }
    const args = argsRaw as string[]
    byKey.set(key, {
      qualifiedKey: key,
      name,
      sourceKind,
      projectId,
      command: cfg.command,
      args,
      env,
      configHash: canonicalMcpConfigHash(cfg.command, args, env),
    })
  }

  /** Parse a JSON file; ENOENT → null silently; anything else → warning + null. */
  const readJsonFile = (file: string, source: string): Record<string, unknown> | null => {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push({ path: file, message: `[${source}] unreadable config — skipped (${(e as Error).message})` })
      }
      return null
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch (e) {
      warnings.push({ path: file, message: `[${source}] unparseable JSON — skipped (${(e as Error).message})` })
      return null
    }
  }

  // 1. Project .mcp.json files FIRST (lowest precedence — ~/.claude.json project
  //    entries overwrite them below, mirroring Claude's local-over-shared scoping).
  for (const project of projects) {
    const mcpJsonPath = path.join(project.localPath, '.mcp.json')
    const parsed = readJsonFile(mcpJsonPath, 'claude-project')
    const servers = parsed?.mcpServers
    if (typeof servers !== 'object' || servers === null) continue
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      addServer(name, cfg, 'claude-project', project.id, mcpJsonPath)
    }
  }

  const claudeJson = readJsonFile(claudeJsonPath, 'claude-user')

  // 2. ~/.claude.json project scopes, matched to REGISTERED projects only.
  const registered = new Map<string, ProjectRef>()
  for (const project of projects) registered.set(normalizeProjectPath(project.localPath, platform), project)
  const projectScopes = claudeJson?.projects
  if (typeof projectScopes === 'object' && projectScopes !== null) {
    for (const [rawPath, scopeRaw] of Object.entries(projectScopes as Record<string, unknown>)) {
      const project = registered.get(normalizeProjectPath(rawPath, platform))
      if (!project) continue // unregistered host project — out of scope
      const scope = (scopeRaw ?? {}) as Record<string, unknown>
      const servers = scope.mcpServers
      if (typeof servers !== 'object' || servers === null) continue
      for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
        addServer(name, cfg, 'claude-project', project.id, claudeJsonPath)
      }
    }
  }

  // 3. User scope: top-level mcpServers.
  const userServers = claudeJson?.mcpServers
  if (typeof userServers === 'object' && userServers !== null) {
    for (const [name, cfg] of Object.entries(userServers as Record<string, unknown>)) {
      addServer(name, cfg, 'claude-user', null, claudeJsonPath)
    }
  }

  return { items: [...byKey.values()], warnings }
}

// ─── sync (the ONE transactional upsert) ──────────────────────────────────────

// Statements owned here (not db.ts) so the catalog surface stays out of the
// shared accumulation file. Prepared LAZILY on first use — NEVER at module
// evaluation: db.ts's migration calls authority.ts::resolveAuthority, and
// authority.ts imports THIS module, so db.ts → authority.ts → host-discovery.ts
// → db.ts is a load-time CYCLE in which the db binding is not yet initialized
// while this module's body runs. Every runtime call site sees the live binding.
type Stmt = DatabaseType.Statement
function lazy(sql: string): () => Stmt {
  let s: Stmt | undefined
  return () => (s ??= db.prepare(sql))
}
const getSkillByKey = lazy(`SELECT * FROM skills WHERE qualified_key = ?`)
const insertDiscoveredSkill = lazy(`
  INSERT INTO skills (id, name, description, type, source, triggerType, schedule, eventTrigger,
                      enabled, createdAt, source_kind, origin_path, project_id, plugin_id,
                      plugin_version, content_hash, est_tokens, est_tokens_meta, status,
                      last_scanned_at, qualified_key)
  VALUES (@id, @name, @description, 'skill', @source, 'manual', NULL, NULL,
          0, @now, @sourceKind, @originPath, @projectId, @pluginId,
          @pluginVersion, @contentHash, @estTokens, @estTokensMeta, 'ok',
          @now, @qualifiedKey)
`)
// Metadata refresh — deliberately NEVER touches `enabled` (the K-scoped overlay),
// id, type, triggerType, or createdAt.
const updateDiscoveredSkill = lazy(`
  UPDATE skills
  SET name = @name, description = @description, source = @source, origin_path = @originPath,
      project_id = @projectId, plugin_id = @pluginId, plugin_version = @pluginVersion,
      content_hash = @contentHash, est_tokens = @estTokens, est_tokens_meta = @estTokensMeta,
      status = 'ok', last_scanned_at = @now
  WHERE qualified_key = @qualifiedKey
`)
const listDiscoveredSkillRows = lazy(`SELECT * FROM skills WHERE source_kind != 'k'`)
// A missing flip keeps last_scanned_at as the LAST TIME THE ASSET WAS SEEN.
const markSkillMissing = lazy(`UPDATE skills SET status = 'missing' WHERE qualified_key = ?`)
const deleteSkillByKey = lazy(`DELETE FROM skills WHERE qualified_key = ?`)

const getMcpByKey = lazy(`SELECT * FROM host_mcp_servers WHERE qualified_key = ?`)
const insertHostMcp = lazy(`
  INSERT INTO host_mcp_servers (id, name, qualified_key, source_kind, project_id, command, args, env,
                                config_hash, enabled, trusted_hash, trusted_at, est_tokens,
                                probe_status, status, discovered_at, last_scanned_at)
  VALUES (@id, @name, @qualifiedKey, @sourceKind, @projectId, @command, @args, @env,
          @configHash, 0, NULL, NULL, NULL,
          NULL, 'ok', @now, @now)
`)
const updateHostMcpMeta = lazy(`
  UPDATE host_mcp_servers
  SET name = @name, command = @command, args = @args, env = @env, config_hash = @configHash,
      status = 'ok', last_scanned_at = @now
  WHERE qualified_key = @qualifiedKey
`)
// D-070 drift consequence: config changed under a pinned trust → auto-disable +
// clear the pin (the operator must re-review + re-trust the NEW config).
const revokeHostMcpTrust = lazy(`
  UPDATE host_mcp_servers SET enabled = 0, trusted_hash = NULL, trusted_at = NULL WHERE qualified_key = ?
`)
const listHostMcpRows = lazy(`SELECT * FROM host_mcp_servers`)
const markMcpMissing = lazy(`UPDATE host_mcp_servers SET status = 'missing' WHERE qualified_key = ?`)
const deleteMcpByKey = lazy(`DELETE FROM host_mcp_servers WHERE qualified_key = ?`)

// ─── catalog readers (the authority/synth consumers — D-069/D-070 gating) ────

const listEnabledOkDiscoveredSkills = lazy(
  `SELECT qualified_key FROM skills WHERE source_kind != 'k' AND enabled = 1 AND status = 'ok'`,
)
// "Trusted" = a pin exists AND it matches the CURRENT config hash (drift clears the
// pin at rescan, but a manual row edit must not slip through either — belt+braces).
const listEnabledTrustedOkMcp = lazy(
  `SELECT qualified_key, name FROM host_mcp_servers
   WHERE enabled = 1 AND status = 'ok' AND trusted_hash IS NOT NULL AND trusted_hash = config_hash`,
)

/** Qualified keys of every discovered skill that is enabled AND status-ok — the
 *  discovered half of resolveEffectiveCeiling (authority.ts). */
export function listEnabledDiscoveredSkillKeys(): string[] {
  return (listEnabledOkDiscoveredSkills().all() as Array<{ qualified_key: string }>).map(r => r.qualified_key)
}

/** Enabled + trusted (pin matches the current hash) + status-ok host MCP servers.
 *  `name` is what the mcp__<name> grant token keys on. */
export function listEnabledTrustedHostMcpServers(): Array<{ qualifiedKey: string; name: string }> {
  return (listEnabledTrustedOkMcp().all() as Array<{ qualified_key: string; name: string }>).map(r => ({
    qualifiedKey: r.qualified_key,
    name: r.name,
  }))
}

/** Raw catalog row for a skill qualified key (any source_kind) — the detailed
 *  WHY-rejected lookups in authority.ts::assertEffectiveGrants. */
export function getCatalogSkillRow(qualifiedKey: string): Record<string, unknown> | undefined {
  return getSkillByKey().get(qualifiedKey) as Record<string, unknown> | undefined
}

/** Raw host_mcp_servers row for a qualified key. */
export function getHostMcpServerRow(qualifiedKey: string): Record<string, unknown> | undefined {
  return getMcpByKey().get(qualifiedKey) as Record<string, unknown> | undefined
}

/** projectId → <localPath>/.claude/skills for every REGISTERED project — the
 *  projectRoots map for resolveSkillRoots (a deregistered project closes its
 *  root: its paths stop confining, fail-closed — skill-roots.ts). */
export function registeredProjectSkillRoots(): Map<string, string> {
  const roots = new Map<string, string>()
  for (const p of registeredProjects()) roots.set(p.id, path.join(p.localPath, '.claude', 'skills'))
  return roots
}

/** app_config key persisting the last RescanResult (durable across restarts) —
 *  the source for GET /api/capabilities/* `scannedAt` + `warnings` (A4). */
const LAST_RESCAN_KEY = 'capabilities.lastRescan'

/** The last persisted rescan result, Zod-checked on the way out (a garbled row
 *  degrades to null, never a throw). */
export function readLastRescanResult(): RescanResult | null {
  const raw = configDb.get(LAST_RESCAN_KEY)
  if (!raw) return null
  try {
    return RescanResultSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Every qualified key referenced by any profile row (skills[] ∪ mcpServers[]) —
 *  a referenced-but-missing asset is KEPT (status='missing') so the profile's
 *  fail-closed rejection at PATCH/synth can name it; only unreferenced+disabled
 *  rows are deleted on absence. */
function profileReferences(): { skills: Set<string>; mcp: Set<string> } {
  const skills = new Set<string>()
  const mcp = new Set<string>()
  for (const row of agentProfilesDb.listProfileRows.all() as Record<string, unknown>[]) {
    const profile = rowToAgentProfile(row)
    for (const s of profile.skills) skills.add(s)
    for (const m of profile.mcpServers) mcp.add(m)
  }
  return { skills, mcp }
}

/**
 * Apply one discovery snapshot to the catalog in ONE db.transaction (all-or-
 * nothing: a mid-apply failure rolls the whole rescan back — no half-synced
 * catalog). Exported for the atomicity test; production callers use
 * syncHostDiscovery. Count semantics:
 *   - discovered = new rows inserted (always enabled=0);
 *   - updated    = existing rows whose content/config/metadata actually changed
 *                  (a re-seen identical row refreshes last_scanned_at but is not
 *                  counted);
 *   - missing    = rows that VANISHED this scan — newly flagged 'missing' plus
 *                  unreferenced+disabled rows deleted outright.
 * The result (including warnings) is persisted to app_config inside the same
 * transaction, so `scannedAt`/`warnings` never desync from the catalog state.
 */
export function applyHostDiscovery(
  skills: DiscoveredSkill[],
  servers: DiscoveredMcpServer[],
  warnings: CatalogWarning[],
  now: number = Date.now(),
): RescanResult {
  const allWarnings = [...warnings]
  const apply = db.transaction((): RescanResult => {
    const refs = profileReferences()
    const skillCounts = { discovered: 0, updated: 0, missing: 0 }
    const mcpCounts = { discovered: 0, updated: 0, missing: 0 }

    // ── skills upsert (by qualified_key; overlay NEVER touched) ────────────────
    const seenSkillKeys = new Set<string>()
    for (const s of skills) {
      seenSkillKeys.add(s.qualifiedKey)
      const existing = getSkillByKey().get(s.qualifiedKey) as Record<string, unknown> | undefined
      const params = {
        name: s.name,
        description: s.description,
        source: s.originPath, // a discovered row's `source` degrade-text IS its provenance path
        originPath: s.originPath,
        projectId: s.projectId,
        pluginId: s.pluginId,
        pluginVersion: s.pluginVersion,
        contentHash: s.contentHash,
        estTokens: s.estTokens,
        estTokensMeta: s.estTokensMeta,
        qualifiedKey: s.qualifiedKey,
        now,
      }
      if (!existing) {
        insertDiscoveredSkill().run({ ...params, id: randomUUID(), sourceKind: s.sourceKind })
        skillCounts.discovered++
      } else {
        const changed =
          existing.content_hash !== s.contentHash ||
          existing.status !== 'ok' ||
          existing.name !== s.name ||
          existing.description !== s.description ||
          existing.origin_path !== s.originPath ||
          existing.plugin_version !== s.pluginVersion
        updateDiscoveredSkill().run(params)
        if (changed) skillCounts.updated++
      }
    }

    // ── skills: previously-discovered-now-absent ───────────────────────────────
    for (const row of listDiscoveredSkillRows().all() as Record<string, unknown>[]) {
      const key = String(row.qualified_key)
      if (seenSkillKeys.has(key)) continue
      const referenced = refs.skills.has(key)
      const enabled = Number(row.enabled) === 1
      if (!referenced && !enabled) {
        deleteSkillByKey().run(key)
        skillCounts.missing++
      } else if (row.status !== 'missing') {
        markSkillMissing().run(key)
        skillCounts.missing++
      }
    }

    // ── host MCP upsert ────────────────────────────────────────────────────────
    const seenMcpKeys = new Set<string>()
    for (const srv of servers) {
      seenMcpKeys.add(srv.qualifiedKey)
      const existing = getMcpByKey().get(srv.qualifiedKey) as Record<string, unknown> | undefined
      const params = {
        name: srv.name,
        command: srv.command,
        args: JSON.stringify(srv.args),
        env: JSON.stringify(srv.env),
        configHash: srv.configHash,
        qualifiedKey: srv.qualifiedKey,
        now,
      }
      if (!existing) {
        insertHostMcp().run({ ...params, id: randomUUID(), sourceKind: srv.sourceKind, projectId: srv.projectId })
        mcpCounts.discovered++
      } else {
        const hashChanged = existing.config_hash !== srv.configHash
        updateHostMcpMeta().run(params)
        // Trust pin vs LIVE config (D-070): drift auto-disables + clears trust.
        if (existing.trusted_hash != null && existing.trusted_hash !== srv.configHash) {
          revokeHostMcpTrust().run(srv.qualifiedKey)
          allWarnings.push({
            path: srv.command,
            message: `[${srv.sourceKind}] MCP server "${srv.qualifiedKey}" config changed since it was trusted — auto-disabled, trust cleared (re-review to re-enable)`,
          })
        }
        if (hashChanged || existing.status !== 'ok') mcpCounts.updated++
      }
    }

    // ── host MCP: now-absent ───────────────────────────────────────────────────
    for (const row of listHostMcpRows().all() as Record<string, unknown>[]) {
      const key = String(row.qualified_key)
      if (seenMcpKeys.has(key)) continue
      const referenced = refs.mcp.has(key)
      const enabled = Number(row.enabled) === 1
      if (!referenced && !enabled) {
        deleteMcpByKey().run(key)
        mcpCounts.missing++
      } else if (row.status !== 'missing') {
        markMcpMissing().run(key)
        mcpCounts.missing++
      }
    }

    const result: RescanResult = {
      scannedAt: now,
      skills: skillCounts,
      mcpServers: mcpCounts,
      warnings: allWarnings,
    }
    // Persisted INSIDE the transaction: the recorded scannedAt/warnings can never
    // describe a rescan that only half-applied.
    configDb.set(LAST_RESCAN_KEY, JSON.stringify(result))
    return result
  })
  return apply()
}

export interface SyncHostDiscoveryOpts {
  /** Host claude home (default <os.homedir()>/.claude) — injectable for tests. */
  claudeHome?: string
  /** Host claude.json (default <os.homedir()>/.claude.json) — injectable for tests. */
  claudeJsonPath?: string
  /** Registered projects to scan (default: the projects table). */
  projects?: ProjectRef[]
  /** win32 project matching is case-insensitive — injectable for tests. */
  platform?: NodeJS.Platform
  /** Scan timestamp (default Date.now()) — injectable for tests. */
  now?: number
}

/** The registered projects, as scanner refs. */
function registeredProjects(): ProjectRef[] {
  return (projectsDb.listProjects.all() as Record<string, unknown>[]).map(r => ({
    id: String(r.id),
    localPath: String(r.local_path),
  }))
}

/**
 * Run all four host scanners and apply the snapshot transactionally. Never throws
 * for a malformed HOST (that's a warning); it CAN throw for a broken K (db
 * unavailable) — the boot call site wraps it in try/catch-warn so a broken host
 * integration can never brick boot.
 */
export function syncHostDiscovery(opts: SyncHostDiscoveryOpts = {}): RescanResult {
  const claudeHome = opts.claudeHome ?? path.join(os.homedir(), '.claude')
  const claudeJsonPath = opts.claudeJsonPath ?? path.join(os.homedir(), '.claude.json')
  const projects = opts.projects ?? registeredProjects()

  const user = scanUserSkills(claudeHome)
  const project = scanProjectSkills(projects)
  const plugin = scanPluginSkills(claudeHome)
  const mcp = scanHostMcpServers(claudeJsonPath, projects, { platform: opts.platform })

  return applyHostDiscovery(
    [...user.items, ...project.items, ...plugin.items],
    mcp.items,
    [...user.warnings, ...project.warnings, ...plugin.warnings, ...mcp.warnings],
    opts.now ?? Date.now(),
  )
}
