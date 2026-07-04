/**
 * Per-run config synthesizer — the second half of K's agent-engine boundary.
 *
 * K spawns the Claude Code CLI as its agent engine. `synthesizeConfigDir` reads
 * the committed, K-OWNED assets in `agent-config/` (base operating prompt, tier
 * charters, allowlists, MCP configs, settings template, gitnexus hook + skills)
 * and materializes an EPHEMERAL config dir for one run. The CLI is then spawned
 * with CLAUDE_CONFIG_DIR pointed at that dir.
 *
 * Wave-0 finding: pointing CLAUDE_CONFIG_DIR at a dir replaces the ENTIRE host
 * config layer — skills, plugins, MCP, settings, AND credentials. Because the
 * host ~/.claude is no longer loaded, the synthesizer must also resolve auth:
 * a K-supplied token (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) is preferred,
 * with a host-credential copy as a dogfooding fallback.
 *
 * Every write is path-guarded to stay under the run's configDir (the scaffold.ts
 * `writeIfAbsent` guard pattern), so a malformed tier name can never escape the
 * run sandbox.
 *
 * Profile-row overrides (B1): the synthesizer honors the profile's
 * allowedTools / mcpServers / skills rows. An EMPTY (or absent — rowToAgentProfile
 * degrades garbled JSON to []) profile array means "no override → use the tier
 * asset". A NON-EMPTY array is the operator's narrowed grant and is enforced
 * FAIL-CLOSED against the tier assets: the TIER defines the CEILING (allowlist /
 * mcp template / bundle) and a profile row may only narrow within it — an
 * above-ceiling tool, an unknown MCP server, or an out-of-bundle skill throws
 * rather than silently mounting/granting.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import type { AgentProfile } from './profiles.js'
import { assertMcpGrants, computeDisallowedTools, toolWithinCeiling } from './authority.js'
import { isPathWithin } from './paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')
// Mirrors claude-args / db DATA_DIR: env override, else repo-root data/.
const DEFAULT_DATA_DIR = path.join(__dirname, '../../data')
// The durable tiers a charter may resolve to. assertSafeSegment blocks traversal;
// this blocks a safe-but-unknown tier (e.g. a poisoned Phase-5 DB profile row)
// from silently selecting an unintended bundle/allowlist/charter.
const KNOWN_CHARTERS = new Set(['orchestrator', 'chief', 'secretary'])

export interface SynthesizedConfig {
  configDir: string                 // → CLAUDE_CONFIG_DIR for the spawn
  allowedTools: string[]            // → claude --allowedTools
  disallowedTools: string[]         // → claude --disallowedTools (UNIVERSE minus the run's grant — the hard ceiling)
  mcpConfigPath: string             // → claude --mcp-config (+ --strict-mcp-config)
  settingsPath: string              // → claude --settings
  appendSystemPromptFile: string    // → claude --append-system-prompt-file (L0 + L1)
  authEnv: Record<string, string>   // → merged into the spawn env (may be empty)
  usedHostCredentialFallback: boolean
  cleanup: () => void               // removes the run's config dir
}

export interface SynthesizeOpts {
  runId: string
  assetsDir?: string            // default: repo-root agent-config/
  dataDir?: string              // default: process.env.K_DATA_DIR ?? <repo>/data
  hostCredentialsPath?: string  // default: <home>/.claude/.credentials.json — INJECTABLE for tests
  // W7a: a STABLE run dir (absolute) to build the config under instead of the default
  // per-run `<dataDir>/agent-runs/<runId>`. K-secretary asks pass a per-THREAD stable
  // dir so the CLI's session files (stored under CLAUDE_CONFIG_DIR keyed by cwd) survive
  // across asks and `--resume` can find them. MUST stay under dataDir (guard-checked).
  // Absent for every regular dispatch run → the default per-run dir, byte-for-byte as before.
  runDirOverride?: string
  // W7a: when true, cleanup() is a NO-OP so the (stable) run dir — and the CLI session
  // state under it — persists across asks. Absent/false for regular runs → cleanup()
  // removes the ephemeral per-run dir on terminal exactly as before.
  persist?: boolean
}

// ── path guard ─────────────────────────────────────────────────────────────────

/** Throw unless `abs` stays at or under `root` (scaffold.ts guard pattern). */
function guardUnder(root: string, abs: string): void {
  // `inclusive: true` allows `abs === root` (the configDir itself); the shared
  // guard treats a root already ending in a separator (e.g. a drive root "C:\") correctly.
  if (!isPathWithin(root, abs, { inclusive: true })) {
    throw new Error(`agent-config: path escapes configDir — abs="${abs}", root="${root}"`)
  }
}

/**
 * Reject any path segment that could traverse directories. Applied to `runId`
 * (used to build/destroy the run dir) and the tier asset basename (interpolated
 * into asset READ paths, which `guardUnder` does not cover). Inputs are a UUID +
 * a hardcoded tier today, but `SynthesizeOpts`/`AgentProfile` are a public API and
 * Phase-5 profiles come from the DB — so the segment is validated, not trusted.
 */
function assertSafeSegment(value: string, label: string): void {
  if (!/^[a-z0-9-]+$/i.test(value)) {
    throw new Error(`agent-config: unsafe ${label} "${value}" — must match /^[a-z0-9-]+$/i`)
  }
}

/** Path-guarded text write under `root`. */
function guardedWrite(root: string, abs: string, content: string): void {
  guardUnder(root, abs)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

/** Path-guarded file copy under `root`. */
function guardedCopy(root: string, src: string, dest: string): void {
  guardUnder(root, dest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

/** Recursively copy `src` → `dest`, path-guarding every destination under `root`. */
function copyDirGuarded(root: string, src: string, dest: string): void {
  guardUnder(root, dest)
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyDirGuarded(root, s, d)
    else guardedCopy(root, s, d)
  }
}

/** Absolute file:// URL of K's OWN tsx ESM loader (cwd-independent), for the dev
 *  `node --import <loader>` launch of the kstore server. Resolving from this
 *  module's location pins tsx to K's install; never bare `tsx` (cwd-relative,
 *  could load a planted node_modules/tsx). Falls back to bare only if resolution
 *  fails (shouldn't in a dev tree; the built path never calls this). */
function resolveTsxLoader(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  } catch {
    return 'tsx'
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export function synthesizeConfigDir(profile: AgentProfile, opts: SynthesizeOpts): SynthesizedConfig {
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const dataDir = opts.dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR
  const hostCredentialsPath =
    opts.hostCredentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json')
  const charter = profile.charter

  // Reject traversal in the run id (controls runDir + cleanup's rmSync) and the
  // tier asset name (interpolated into asset read paths) before any fs use.
  assertSafeSegment(opts.runId, 'runId')
  assertSafeSegment(charter, 'charter')
  if (!KNOWN_CHARTERS.has(charter)) {
    throw new Error(`agent-config: unknown charter "${charter}" — not one of ${[...KNOWN_CHARTERS].join(', ')}`)
  }

  // ── Profile-row resolution + fail-closed validation (B1) ─────────────────────
  // Resolve the effective skills/servers/tools BEFORE any write (validate-before-
  // mutate): a rejected profile row must throw HERE, so a bad row can never leave a
  // partially materialized run dir behind on every dispatch attempt. An EMPTY
  // profile array (rowToAgentProfile degrades garbled JSON to []) means "no
  // override → the tier asset"; a NON-EMPTY array is the operator's narrowed grant,
  // enforced against the tier assets as the CEILING.

  // Skills: a non-empty profile.skills row narrows WITHIN the tier bundle (the
  // bundle is the ceiling — fail-closed). Every name is segment-checked before it
  // is ever interpolated into a read path (step 4).
  const bundlePath = path.join(assetsDir, 'bundles', `${charter}.json`)
  if (!fs.existsSync(bundlePath)) throw new Error(`agent-config: bundle for tier "${charter}" not found`)
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as {
    skills?: string[]
    agents?: string[]
  }
  const bundleSkills = bundle.skills ?? []
  const usedProfileSkills = profile.skills.length > 0
  const skillsToMount = usedProfileSkills ? profile.skills : bundleSkills
  for (const skill of skillsToMount) {
    assertSafeSegment(skill, 'bundle skill')
    if (usedProfileSkills && !bundleSkills.includes(skill)) {
      throw new Error(
        `agent-config: profile skill "${skill}" is not in the "${charter}" tier bundle — the tier bundle is the ceiling`,
      )
    }
  }

  // MCP servers: the tier's mcp template defines WHICH servers exist (the ceiling).
  // A non-empty profile.mcpServers row mounts exactly those servers; a name with no
  // tier definition is fail-closed (we cannot invent a server config). The parsed
  // template is filtered down to the mounted set here (template key order preserved
  // so the no-override output stays byte-identical).
  const mcp = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'mcp', `${charter}.json`), 'utf8'),
  ) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }
  const tierServerKeys = Object.keys(mcp.mcpServers ?? {})
  const serversToMount = profile.mcpServers.length > 0 ? profile.mcpServers : tierServerKeys
  for (const name of serversToMount) {
    if (!mcp.mcpServers?.[name]) {
      throw new Error(
        `agent-config: profile mounts MCP server "${name}" but tier "${charter}" defines no such server — unknown servers are fail-closed`,
      )
    }
  }
  const wantedServers = new Set(serversToMount)
  mcp.mcpServers = Object.fromEntries(
    Object.entries(mcp.mcpServers ?? {}).filter(([k]) => wantedServers.has(k)),
  )

  // Allowed tools: a non-empty profile.allowedTools row is the operator's narrowed
  // grant, enforced against the tier allowlist as the ceiling (toolWithinCeiling —
  // exact / specifier-narrowed / per-tool-MCP forms). Deliberately INLINE rather
  // than authority.ts::assertTierCeiling: the allowlist is already parsed in hand
  // here; the helper would re-read the assets via resolveAuthority and could drift
  // from the exact file this synthesis consumes.
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'allowlists', `${charter}.json`), 'utf8'),
  ) as { allowedTools: string[] }
  const allowedTools = profile.allowedTools.length > 0 ? profile.allowedTools : allowlist.allowedTools
  if (profile.allowedTools.length > 0) {
    const ceiling = new Set(allowlist.allowedTools)
    for (const tool of allowedTools) {
      if (!toolWithinCeiling(tool, ceiling)) {
        throw new Error(
          `agent-config: profile tool "${tool}" exceeds the "${charter}" tier ceiling — the tier allowlist is the ceiling`,
        )
      }
    }
  }
  // Mounting ≠ granting (D-034) holds at synth time too: every mounted server must
  // be granted by the FINAL (possibly profile-narrowed) allowlist.
  assertMcpGrants(profile.tier, allowedTools, serversToMount)
  // The hard tool ceiling: --allowedTools is only an AUTO-APPROVAL list (under
  // acceptEdits, Write/Edit are auto-approved for every tier and other built-ins
  // stay invocable subject to prompts). The denylist — UNIVERSE minus the run's
  // (possibly profile-narrowed) grant — is what makes the allowlist a real ceiling
  // for built-ins at the CLI.
  const disallowedTools = computeDisallowedTools(allowedTools)

  // 1. run config dir (path-guarded root for every write below). A K-secretary ask
  //    passes a STABLE per-thread runDirOverride so its config + CLI session state
  //    persist across asks; every regular run gets the ephemeral per-run default.
  const runDir = opts.runDirOverride ?? path.join(dataDir, 'agent-runs', opts.runId)
  guardUnder(dataDir, runDir) // defense-in-depth: runDir (and thus cleanup) stays under dataDir
  const configDir = path.join(runDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })

  // 2. layered system prompt: L0 base operating prompt + L1 tier charter.
  //    Written as ONE file (no config-dir CLAUDE.md) to avoid double injection.
  const l0 = fs.readFileSync(path.join(assetsDir, 'base-operating-prompt.md'), 'utf8')
  const l1 = fs.readFileSync(path.join(assetsDir, 'tiers', `${charter}.charter.md`), 'utf8')
  const appendSystemPromptFile = path.join(configDir, 'system-prompt.md')
  guardedWrite(configDir, appendSystemPromptFile, `${l0}\n\n---\n\n${l1}`)

  // 3. settings: rewrite every __HOOK__ placeholder to the run's hooks dir
  //    (forward slashes so the JSON value is valid on Windows too).
  const template = fs.readFileSync(path.join(assetsDir, 'settings.template.json'), 'utf8')
  const hooksDirFwd = path.join(configDir, 'hooks').split(path.sep).join('/')
  const settingsPath = path.join(configDir, 'settings.json')
  guardedWrite(configDir, settingsPath, template.split('__HOOK__').join(hooksDirFwd))

  // 4. mount ONLY the skills + worker-agent defs resolved in the validation block
  //    above (profile-narrowed or the tier bundle) — not the whole library. The
  //    orchestrator bundle carries the full roster; chief and secretary carry no
  //    coding agents. Skill names were segment-checked before any path use.
  for (const skill of skillsToMount) {
    const src = path.join(assetsDir, 'skills', skill)
    if (!fs.existsSync(src)) throw new Error(`agent-config: bundle skill "${skill}" not found`)
    copyDirGuarded(configDir, src, path.join(configDir, 'skills', skill))
  }
  for (const agent of bundle.agents ?? []) {
    assertSafeSegment(agent, 'bundle agent')
    const src = path.join(assetsDir, 'agents', `${agent}.md`)
    if (!fs.existsSync(src)) throw new Error(`agent-config: bundle agent "${agent}" not found`)
    guardedCopy(configDir, src, path.join(configDir, 'agents', `${agent}.md`))
  }

  // 5. vendor hooks/ into the run dir.
  copyDirGuarded(configDir, path.join(assetsDir, 'hooks'), path.join(configDir, 'hooks'))

  // 6. MCP config → mcp.json from the (validated, possibly profile-narrowed)
  //    template parsed above: resolve every RUN-SCOPED K server (kstore, logistics,
  //    mgmt) — each placeholder command/args become THIS core's server launch (dev
  //    runs the .ts via tsx; a build runs the .js), and its env gets the run's
  //    K_DATA_DIR / K_RUN_ID so the child opens the right k.db and resolves the
  //    right run. Other servers (gitnexus) pass through untouched. Behaviour for
  //    kstore is unchanged from the single-server form (proven by the existing
  //    synthesis tests).
  const runScopedServers: Array<[string, string]> = [
    ['kstore', 'k-store-server'],
    ['logistics', 'logistics-server'],
    ['mgmt', 'mgmt-server'],
  ]
  const ext = path.extname(fileURLToPath(import.meta.url)) // '.ts' under tsx, '.js' built
  for (const [key, moduleBase] of runScopedServers) {
    const srv = mcp.mcpServers?.[key]
    if (!srv) continue
    const serverPath = path.join(__dirname, 'mcp', `${moduleBase}${ext}`)
    if (!fs.existsSync(serverPath)) {
      throw new Error(`agent-config: ${key} server module not found at ${serverPath}`)
    }
    srv.command = process.execPath
    // Dev (.ts) needs the tsx loader. Pin it to an ABSOLUTE path resolved from
    // K's own install — never bare `tsx`, whose resolution is cwd-relative and
    // could load a malicious node_modules/tsx planted in the agent's project.
    srv.args = ext === '.ts' ? ['--import', resolveTsxLoader(), serverPath] : [serverPath]
    srv.env = { ...(srv.env ?? {}), K_DATA_DIR: dataDir, K_RUN_ID: opts.runId }
  }
  const mcpConfigPath = path.join(configDir, 'mcp.json')
  guardedWrite(configDir, mcpConfigPath, JSON.stringify(mcp, null, 2))

  // 7. allowlist — `allowedTools` was resolved + ceiling-checked in the validation
  //    block above (before any write).

  // 8. auth resolution (Wave-0 finding: credentials are isolated too).
  //    Prefer a K-supplied token; else copy host credentials as a dogfooding
  //    fallback; else run unauthenticated (warn).
  let authEnv: Record<string, string> = {}
  let usedHostCredentialFallback = false
  const apiKey = process.env.ANTHROPIC_API_KEY
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (apiKey) {
    authEnv = { ANTHROPIC_API_KEY: apiKey }
  } else if (oauth) {
    authEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauth }
  } else if (fs.existsSync(hostCredentialsPath)) {
    const credDest = path.join(configDir, '.credentials.json')
    guardedCopy(configDir, hostCredentialsPath, credDest)
    try { fs.chmodSync(credDest, 0o600) } catch { /* best-effort on FSes that honour it */ }
    usedHostCredentialFallback = true
    console.warn(
      '[agent-config] no K auth token set — copied host ~/.claude/.credentials.json into the run (dogfooding fallback)',
    )
  } else {
    console.warn(
      '[agent-config] no auth configured (no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / host credentials) — this run will be unauthenticated',
    )
  }

  // 9. cleanup removes the whole run dir (config + any siblings). For a PERSISTED
  //    (K-secretary) config this is a NO-OP so the stable dir — and the CLI session
  //    files under it that `--resume` needs — survive across asks.
  const cleanup = opts.persist
    ? (): void => { /* persisted: keep the stable dir + its CLI session state */ }
    : (): void => { fs.rmSync(runDir, { recursive: true, force: true }) }

  return {
    configDir,
    allowedTools,
    disallowedTools,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile,
    authEnv,
    usedHostCredentialFallback,
    cleanup,
  }
}

/**
 * Resolve the STABLE per-K-thread paths a K-secretary ask reuses across invocations
 * (W7a, design A). Both live under a dedicated `<dataDir>/k-secretary/<key>` namespace
 * — deliberately NOT under `agent-runs/` — so the boot orphan-sweep
 * (pruneOrphanAgentRuns), which reaps every `agent-runs/<id>` not held by a live run,
 * never deletes K's persistent session state. `runDir` is fed to synthesizeConfigDir's
 * runDirOverride (its config lands at `<runDir>/config`); `cwd` is the stable working
 * directory the CLI keys its session files under, so `--resume` finds them. `key` is the
 * thread id — segment-checked here before any path use (it is interpolated into fs paths).
 */
export function kSecretaryConfigPaths(key: string, dataDir?: string): { runDir: string; cwd: string } {
  assertSafeSegment(key, 'k-secretary thread key')
  const base = path.join(dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR, 'k-secretary', key)
  return { runDir: path.join(base, 'agent'), cwd: path.join(base, 'cwd') }
}

/**
 * Best-effort boot sweep of orphaned per-run config dirs left by crashed runs.
 * Removes every `<dataDir>/agent-runs/<id>` whose `id` is NOT in `activeRunIds`.
 * Mirrors supervisor.pruneOrphanWorktrees: every step is guarded and logged, the
 * function never throws (a Windows file lock can make a removal fail), and it uses
 * the same default dataDir resolution as `synthesizeConfigDir`. Call from the boot
 * reconciliation once the set of in-flight run ids is known.
 */
export function pruneOrphanAgentRuns(activeRunIds: Set<string>, dataDir?: string): void {
  const runsDir = path.join(dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR, 'agent-runs')
  try {
    if (!fs.existsSync(runsDir)) return
    for (const entry of fs.readdirSync(runsDir)) {
      // Active runs hold their config dir; anything else here is orphaned by a
      // crash (a clean exit calls cleanup()). Remove best-effort.
      if (activeRunIds.has(entry)) continue
      const dir = path.join(runsDir, entry)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[agent-config] could not remove orphan agent-run ${dir}:`, (err as Error).message)
      }
    }
  } catch (err) {
    console.warn('[agent-config] agent-runs sweep failed:', (err as Error).message)
  }
}
