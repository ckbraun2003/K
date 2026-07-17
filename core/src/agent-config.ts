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
import type { SubAgentDef } from '@k/shared'
import { isPathWithin } from './paths.js'
// NOTE (A3): run-assets.ts imports THIS module's assertSafeSegment/KNOWN_CHARTERS/
// resolveTsxLoader, so this import is a (benign) cycle — both module bodies are
// inert; every cross-reference happens inside functions, at call time.
import { resolveRunAssets } from './run-assets.js'
import { kNativeSourceStem } from './sub-agents.js'
import type { ProjectRef } from './host-discovery.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')
// Mirrors claude-args / db DATA_DIR: env override, else repo-root data/.
const DEFAULT_DATA_DIR = path.join(__dirname, '../../data')
// The durable tiers a charter may resolve to. assertSafeSegment blocks traversal;
// this blocks a safe-but-unknown tier (e.g. a poisoned Phase-5 DB profile row)
// from silently selecting an unintended bundle/allowlist/charter. Exported so the
// run-assets shim (run-assets.ts) gates on the SAME set — one source, no drift.
export const KNOWN_CHARTERS = new Set(['orchestrator', 'chief', 'secretary'])

/** The per-run agent dir (config + CLI session state) for a managed run — the
 *  default synthesizeConfigDir target. P2 E-02: plan parks PRESERVE this dir
 *  (session transcripts are the resume substrate); approve resumes against it
 *  via runDirOverride. One function so the two paths can never diverge. The
 *  dataDir expression mirrors synthesizeConfigDir's line-388 default AND
 *  pruneOrphanAgentRuns' base — process.env.K_DATA_DIR ?? repo-root data/ — for a
 *  regular dispatch (which never passes opts.dataDir); a caller that overrides
 *  opts.dataDir keeps its own runDir under that guard, unchanged. */
export function agentRunDir(runId: string): string {
  return path.join(process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR, 'agent-runs', runId)
}

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
  // F-068: SUPPRESS the gitnexus bootstrap for a run whose target repo is an EXTERNAL
  // registered project (NOT K's own repo). The gitnexus MCP server's init AND the
  // `gitnexus analyze` nudge (the PostToolUse hook) resolve the canonical repo root via
  // the SHARED git dir, so for a run dispatched into a linked worktree of an external
  // project they write `.gitnexus/`, a `.gitignore` line, and `.claude/skills/gitnexus`
  // into the TARGET checkout (not the ephemeral worktree) — residue removeWorktree never
  // cleans. When true, the gitnexus MCP server is NOT mounted and the gitnexus hook groups
  // are stripped from settings.json, so nothing is ever written into the target repo.
  // Absent/false (every K-internal run — cwd inside the K repo) → gitnexus stays, as before.
  suppressGitnexus?: boolean
  // D-069 (A3): the run's target project — claude-project discovered assets scoped
  // to a DIFFERENT project are silently dropped from the mounts (run-assets.ts).
  // Absent → no project scope (every project-scoped asset drops).
  projectId?: string
  // ── TEST SEAMS (additive-optional; the hostCredentialsPath precedent) — passed
  //    through to resolveRunAssets for discovered-asset resolution. Production
  //    callers omit them (real ~/.claude, ~/.claude.json, projects table).
  claudeHome?: string
  claudeJsonPath?: string
  projects?: ProjectRef[]
  // orch-p2 A.5: the resolved worker-bee def a pipeline `agent` stage's subagentType names
  // (getSubAgentByName, W0). Mounted into the run's agents/ dir (§3.2): a K-native worker copies
  // from assetsDir/agents/<name>.md; an operator worker is copied CONFINED from
  // dataDir/agents/<id>/ (fail-closed — disabled workers skipped, path-escape ids rejected).
  // Absent for every non-pipeline / no-subagent dispatch → unchanged behavior.
  subagent?: SubAgentDef | null
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
 * Exported so the run-assets shim applies the SAME validation (one source).
 */
export function assertSafeSegment(value: string, label: string): void {
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

// ── confined vendoring (D-069 guard widening) ─────────────────────────────────

/** Hard caps for one vendored skill dir — a hostile/degenerate host skill cannot
 *  balloon a run config (fail-closed: breach THROWS, the dispatch is refused). */
export const COPY_CONFINED_MAX_FILES = 500
export const COPY_CONFINED_MAX_BYTES = 10 * 1024 * 1024

/**
 * Copy a DISCOVERED skill dir `src` → `dest` with guards on BOTH sides — the
 * vendoring primitive for host content (copyDirGuarded stays for K's own assets):
 *   - dest side: guardUnder(destRoot, …) per entry — unchanged semantics;
 *   - src side: `src` must realpath-confine under `srcRoot` (throw — caller bug or
 *     attack); every entry is lstat'd via Dirent — a SYMLINK is SKIPPED with a
 *     warning (never followed); every FILE's realpath must stay under the real
 *     srcRoot (a junction/mount escape is skipped with a warning) and is copied
 *     from its REAL path;
 *   - hard caps: > COPY_CONFINED_MAX_FILES files or > COPY_CONFINED_MAX_BYTES
 *     cumulative bytes for this one skill dir → THROW (fail-closed).
 */
export function copyDirConfined(srcRoot: string, src: string, destRoot: string, dest: string): void {
  const realSrcRoot = fs.realpathSync(srcRoot)
  const realSrc = fs.realpathSync(src)
  if (!isPathWithin(realSrcRoot, realSrc)) {
    throw new Error(`agent-config: copyDirConfined src escapes its root — src="${src}", root="${srcRoot}"`)
  }
  let files = 0
  let bytes = 0
  const walk = (from: string, to: string): void => {
    guardUnder(destRoot, to)
    fs.mkdirSync(to, { recursive: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name)
      const d = path.join(to, e.name)
      if (e.isSymbolicLink()) {
        console.warn(`[agent-config] copyDirConfined: symlink skipped (never followed): ${s}`)
        continue
      }
      if (e.isDirectory()) {
        walk(s, d)
        continue
      }
      if (!e.isFile()) {
        console.warn(`[agent-config] copyDirConfined: irregular entry skipped: ${s}`)
        continue
      }
      // Source-side realpath containment PER FILE: an escape (junction, bind
      // mount) is skipped — the file is simply not vendored (warn, fail-closed).
      let real: string
      let size: number
      try {
        real = fs.realpathSync(s)
        size = fs.statSync(real).size
      } catch (err) {
        console.warn(`[agent-config] copyDirConfined: unreadable entry skipped: ${s} (${(err as Error).message})`)
        continue
      }
      if (!isPathWithin(realSrcRoot, real)) {
        console.warn(`[agent-config] copyDirConfined: entry resolves outside the source root — skipped: ${s}`)
        continue
      }
      files += 1
      bytes += size
      if (files > COPY_CONFINED_MAX_FILES) {
        throw new Error(
          `agent-config: copyDirConfined: skill dir exceeds ${COPY_CONFINED_MAX_FILES} files — refusing to vendor "${src}" (fail-closed)`,
        )
      }
      if (bytes > COPY_CONFINED_MAX_BYTES) {
        throw new Error(
          `agent-config: copyDirConfined: skill dir exceeds ${COPY_CONFINED_MAX_BYTES} bytes — refusing to vendor "${src}" (fail-closed)`,
        )
      }
      guardUnder(destRoot, d)
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(real, d)
    }
  }
  walk(realSrc, dest)
}

/**
 * F-068: remove every settings.json hook group whose command invokes the gitnexus hook,
 * so an EXTERNAL-target run never runs the `gitnexus analyze` nudge against the target
 * repo. Returns the settings JSON text with those groups dropped (and any now-empty event
 * array removed). Every hook in the shipped template IS a gitnexus hook, so this yields an
 * empty `hooks` object today — but it is written as a targeted filter (matches the
 * `gitnexus-hook` command) so a future non-gitnexus hook survives suppression.
 */
function stripGitnexusHooks(settingsJson: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  const hooks = parsed.hooks
  if (hooks && typeof hooks === 'object') {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue
      const kept = groups.filter(
        g =>
          !(
            Array.isArray(g.hooks) &&
            g.hooks.some(h => typeof h.command === 'string' && h.command.includes('gitnexus-hook'))
          ),
      )
      if (kept.length > 0) hooks[event] = kept
      else delete hooks[event]
    }
  }
  return JSON.stringify(parsed, null, 2)
}

/** Absolute file:// URL of K's OWN tsx ESM loader (cwd-independent), for the dev
 *  `node --import <loader>` launch of the kstore server. Resolving from this
 *  module's location pins tsx to K's install; never bare `tsx` (cwd-relative,
 *  could load a planted node_modules/tsx). Falls back to bare only if resolution
 *  fails (shouldn't in a dev tree; the built path never calls this). Exported so
 *  the run-assets shim resolves the SAME loader (same package → same result). */
export function resolveTsxLoader(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  } catch {
    return 'tsx'
  }
}

// ── credential posture (F-064/F-090) ────────────────────────────────────────────

/**
 * Opt-OUT for the host-credential dogfooding fallback (D-027). Default FALSE — the
 * fallback stays on so K authenticates out-of-the-box when no managed token is set.
 * When `K_DISABLE_HOST_CREDENTIAL_FALLBACK` is set truthy, a run with no managed
 * token FAILS CLOSED (unauthenticated) instead of copying host ~/.claude
 * credentials into the run dir — for security-conscious deployments that must never
 * let a host credential leave ~/.claude. Pure; reads only the env. Truthy = one of
 * true/1/yes/on (case-insensitive) so a misspelt value can't silently re-enable it.
 */
export function hostCredentialFallbackDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.K_DISABLE_HOST_CREDENTIAL_FALLBACK ?? '').trim())
}

export type CredentialPosture = 'managed' | 'host-fallback' | 'disabled'

/**
 * The harness's credential posture, WITHOUT ever exposing a secret — for the boot
 * summary and /api/status. Mirrors the auth-resolution ladder in synthesizeConfigDir:
 *   - 'managed'       → a managed token is set (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN).
 *   - 'disabled'      → no managed token AND the host-credential fallback is opted out
 *                       (K_DISABLE_HOST_CREDENTIAL_FALLBACK) → runs are unauthenticated.
 *   - 'host-fallback' → no managed token, fallback ON (default) → runs copy host creds.
 * Pure: reads only the env, returns no credential value.
 */
export function credentialPosture(env: NodeJS.ProcessEnv = process.env): CredentialPosture {
  if ((env.ANTHROPIC_API_KEY ?? '').length > 0 || (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').length > 0) {
    return 'managed'
  }
  return hostCredentialFallbackDisabled(env) ? 'disabled' : 'host-fallback'
}

// ── org-role model capability (warn-only) ────────────────────────────────────

/**
 * Whether `modelId` can reliably drive the DEFERRED / dynamic MCP MANAGEMENT tools
 * (lead_list, assign_lead, dispatch_lead, report_list, …) the autonomous org chain
 * depends on. The haiku tier does NOT reliably invoke the deferred-tool protocol, so a
 * Chief or lead run resolved to a haiku model silently stalls the K→Chief→lead chain
 * (live-observed). opus / sonnet / fable are treated as capable; ANY haiku-tier id
 * (`claude-haiku-*`, dated snapshots included) is not. Pure + id-family based so a future
 * haiku snapshot needs no edit here. WARN-ONLY: this predicate only decides whether to
 * surface the warning — callers still dispatch exactly as configured. An absent/empty id
 * → treated as capable (the router resolves a default at dispatch; nothing to warn about).
 */
export function isOrgToolCapableModel(modelId: string | null | undefined): boolean {
  if (!modelId) return true
  return !/haiku/i.test(modelId)
}

/**
 * WARN-ONLY guard for an org-management dispatch (Chief / lead): if `modelId` can't
 * reliably drive the deferred management tools (isOrgToolCapableModel → false), emit ONE
 * clear warning naming the role, the model id, and the consequence, then return true
 * (warned). It does NOT change the model, tokens, tool grants, or dispatch — the operator's
 * configured model still runs (the org may just stall, which the warning explains). Returns
 * false (no warning) for a capable model. Uses the same console.warn sink as the other
 * boot/dispatch warnings so the signal lands in the core log next to the wake/dispatch lines.
 */
export function warnIfOrgRoleModelNotToolCapable(role: string, modelId: string | null | undefined): boolean {
  if (isOrgToolCapableModel(modelId)) return false
  console.warn(
    `[org] ${role} dispatched with model ${modelId}, which may be unable to invoke the ` +
      `deferred management tools; the autonomous chain can stall. Use a sonnet/opus-class ` +
      `model for org roles.`,
  )
  return true
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

  // ── A3 (D-069): ALL validation + asset resolution lives in resolveRunAssets —
  // the model-neutral seam. K-native narrowing (bundle/template/allowlist
  // ceilings, D-034 grant guard, F-068 gitnexus drop) is byte-identical to the
  // pre-A3 inline block (locked by run-assets-shim.test.ts + the existing
  // synthesis suites); discovered-asset admission, live trust re-verify, and
  // project-scope filtering run on top. It throws BEFORE any write below, so the
  // validate-before-mutate discipline is preserved (a rejected profile never
  // leaves a partially materialized run dir).
  const assets = resolveRunAssets(profile, {
    runId: opts.runId,
    projectId: opts.projectId,
    suppressGitnexus: opts.suppressGitnexus,
    assetsDir,
    dataDir,
    claudeHome: opts.claudeHome,
    claudeJsonPath: opts.claudeJsonPath,
    projects: opts.projects,
  })
  const { allowedTools, disallowedTools } = assets

  // 1. run config dir (path-guarded root for every write below). A K-secretary ask
  //    passes a STABLE per-thread runDirOverride so its config + CLI session state
  //    persist across asks; every regular run gets the ephemeral per-run default.
  const runDir = opts.runDirOverride ?? path.join(dataDir, 'agent-runs', opts.runId)
  guardUnder(dataDir, runDir) // defense-in-depth: runDir (and thus cleanup) stays under dataDir
  const configDir = path.join(runDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })

  // 2. layered system prompt: the RESOLVED L0 base + L1 tier charter (same reads,
  //    same joiner — run-assets.ts; parity-locked). Written as ONE file (no
  //    config-dir CLAUDE.md) to avoid double injection.
  const appendSystemPromptFile = path.join(configDir, 'system-prompt.md')
  guardedWrite(configDir, appendSystemPromptFile, assets.systemPrompt)

  // 3. settings: rewrite every __HOOK__ placeholder to the run's hooks dir
  //    (forward slashes so the JSON value is valid on Windows too). For an EXTERNAL-target
  //    run (F-068) the gitnexus hook groups are then stripped so the `gitnexus analyze`
  //    nudge never fires against the target repo. The non-suppressed path stays a pure
  //    string-substitution (byte-identical to before — the idempotency LOCK still holds).
  const template = fs.readFileSync(path.join(assetsDir, 'settings.template.json'), 'utf8')
  const hooksDirFwd = path.join(configDir, 'hooks').split(path.sep).join('/')
  const settingsPath = path.join(configDir, 'settings.json')
  const settingsContent = template.split('__HOOK__').join(hooksDirFwd)
  guardedWrite(
    configDir,
    settingsPath,
    opts.suppressGitnexus ? stripGitnexusHooks(settingsContent) : settingsContent,
  )

  // 4. mount ONLY the RESOLVED skills + worker-agent defs (profile-narrowed or the
  //    tier bundle) — not the whole library. k-native skills vendor exactly as
  //    before (copyDirGuarded from agent-config/skills, bare mount name);
  //    DISCOVERED skills vendor via copyDirConfined — source-side symlink/realpath
  //    guards + hard caps — from their confined host origin into their D-069
  //    collision-safe mount dir. Host content is COPIED at synth time; a run never
  //    reads host dirs live. Names/paths were validated at resolve.
  for (const skill of assets.skills) {
    const dest = path.join(configDir, 'skills', skill.mountDirName)
    if (skill.sourceKind === 'k') {
      copyDirGuarded(configDir, skill.srcDir, dest)
    } else {
      // srcRoot is always present on discovered rows (set by resolveRunAssets);
      // fail loudly rather than fall back to an unconfined copy if it ever isn't.
      if (!skill.srcRoot) throw new Error(`agent-config: discovered skill "${skill.qualifiedKey}" resolved without a confinement root`)
      copyDirConfined(skill.srcRoot, skill.srcDir, configDir, dest)
    }
  }
  // Worker-agent defs stay bundle-driven (agents are K-owned assets — not part of
  // the D-069 catalog; chief/secretary bundles carry none).
  const bundle = JSON.parse(fs.readFileSync(path.join(assetsDir, 'bundles', `${charter}.json`), 'utf8')) as {
    agents?: string[]
  }
  for (const agent of bundle.agents ?? []) {
    assertSafeSegment(agent, 'bundle agent')
    const src = path.join(assetsDir, 'agents', `${agent}.md`)
    if (!fs.existsSync(src)) throw new Error(`agent-config: bundle agent "${agent}" not found`)
    guardedCopy(configDir, src, path.join(configDir, 'agents', `${agent}.md`))
  }
  // orch-p2 A.5: mount the stage's resolved worker-bee def (subagentType). A K-native worker
  // ships in assetsDir/agents/<name>.md (bundle-style guardedCopy). An OPERATOR worker is copied
  // CONFINED from dataDir/agents/<id>/ (the Phase-1 hook data/hooks/ confinement idiom — src-side
  // symlink/realpath guards + hard caps). Fail-CLOSED: a DISABLED operator worker is NOT mounted,
  // and assertSafeSegment blocks a path-escape name (K-native filename) or id (operator dir).
  if (opts.subagent) {
    const sa = opts.subagent
    if (sa.source === 'k') {
      // Mount by the source FILE STEM, not the frontmatter `name` — the two differ for a
      // renamed/forked worker, and keying on `name` would silently miss the file (review I-3).
      // kNativeSourceStem resolves the on-disk `<stem>.md`; fall back to `name` (existsSync then
      // false → not mounted, exactly the prior behavior) when no K-native file's name matches.
      const stem = kNativeSourceStem(sa.name) ?? sa.name
      assertSafeSegment(stem, 'subagent stem')
      const src = path.join(assetsDir, 'agents', `${stem}.md`)
      if (fs.existsSync(src)) guardedCopy(configDir, src, path.join(configDir, 'agents', `${stem}.md`))
    } else if (sa.enabled) {
      assertSafeSegment(sa.id, 'subagent id')
      const agentsRoot = path.join(dataDir, 'agents')
      const srcDir = path.join(agentsRoot, sa.id)
      if (fs.existsSync(srcDir)) copyDirConfined(agentsRoot, srcDir, configDir, path.join(configDir, 'agents', sa.id))
    }
  }

  // 5. vendor hooks/ into the run dir.
  copyDirGuarded(configDir, path.join(assetsDir, 'hooks'), path.join(configDir, 'hooks'))

  // 6. MCP config → mcp.json. TIER servers keep the template-based construction
  //    BYTE-IDENTICAL to the pre-A3 output (template root keys incl. _note ride
  //    along; the D-070 allowDiscoveredServers flag is stripped — it is AUTHORITY
  //    data, not run config; template key order preserved through the filter):
  //    every RUN-SCOPED K server (kstore, logistics, mgmt) placeholder becomes
  //    THIS core's server launch (dev runs the .ts via tsx; a build runs the .js)
  //    with the run's K_DATA_DIR / K_RUN_ID env; gitnexus passes through
  //    untouched. DISCOVERED servers are then APPENDED VERBATIM — the exact
  //    trusted {command,args,env}, with NO K_DATA_DIR/K_RUN_ID injection (a host
  //    server is not K's child; it gets nothing but what the operator trusted).
  const mcp = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'mcp', `${charter}.json`), 'utf8'),
  ) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }
  delete (mcp as Record<string, unknown>).allowDiscoveredServers
  const kServerNames = new Set(assets.mcpServers.filter(s => s.sourceKind === 'k').map(s => s.name))
  mcp.mcpServers = Object.fromEntries(
    Object.entries(mcp.mcpServers ?? {}).filter(([k]) => kServerNames.has(k)),
  )
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
  // Discovered servers append AFTER the run-scoped rewrite loop, so a host server
  // that happens to share a run-scoped NAME (mountable only when the K server
  // itself is narrowed out — the resolve-time collision guard forbids both) can
  // never be rewritten into a K-launch.
  for (const srv of assets.mcpServers) {
    if (srv.sourceKind === 'k') continue
    mcp.mcpServers[srv.name] = { command: srv.config.command, args: srv.config.args, env: srv.config.env }
  }
  const mcpConfigPath = path.join(configDir, 'mcp.json')
  guardedWrite(configDir, mcpConfigPath, JSON.stringify(mcp, null, 2))

  // 7. allowlist — `allowedTools` was resolved + ceiling-checked in the validation
  //    block above (before any write).

  // 8. auth resolution (Wave-0 finding: credentials are isolated too).
  //    MANAGED-FIRST: prefer a K-supplied token (ANTHROPIC_API_KEY / OAUTH); else,
  //    unless the operator opted OUT (K_DISABLE_HOST_CREDENTIAL_FALLBACK), copy host
  //    credentials as the dogfooding fallback (D-027 — how K authenticates OOTB);
  //    else run unauthenticated (warn). The managed-token path NEVER copies, so
  //    setting a managed token is also how a persistent K-secretary session avoids
  //    a lingering credential file.
  let authEnv: Record<string, string> = {}
  let usedHostCredentialFallback = false
  const apiKey = process.env.ANTHROPIC_API_KEY
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (apiKey) {
    authEnv = { ANTHROPIC_API_KEY: apiKey }
  } else if (oauth) {
    authEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauth }
  } else if (hostCredentialFallbackDisabled()) {
    // Opt-out (security-conscious): fail closed rather than let a host credential
    // leave ~/.claude. The run is unauthenticated until a managed token is set.
    console.warn(
      '[agent-config] no managed token (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) and ' +
        'K_DISABLE_HOST_CREDENTIAL_FALLBACK is set — refusing to copy host credentials; this run ' +
        'is UNAUTHENTICATED. Set a managed token to authenticate.',
    )
  } else if (fs.existsSync(hostCredentialsPath)) {
    const credDest = path.join(configDir, '.credentials.json')
    guardedCopy(configDir, hostCredentialsPath, credDest)
    // Chmod 0600 (best-effort; honoured on POSIX, advisory on Windows/NTFS ACLs). For a
    // PERSISTED K-secretary session (opts.persist) this file LINGERS across asks under the
    // protected data dir (kSecretaryConfigPaths → <dataDir>/k-secretary/<key>/…). The
    // exposure is bounded by the 0600 perms + the gitignored data dir; a deployment that
    // must avoid a resting credential file should set a managed token (skips this copy
    // entirely) or K_DISABLE_HOST_CREDENTIAL_FALLBACK (opts out above).
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
 * Resolve the STABLE per-(profile, thread) session home an agent session reuses across
 * sends — Continuous Agents W0.3 (D-122), the generalization of kSecretaryConfigPaths
 * (above, untouched) to ANY profile. `base` is what agent_sessions.home_dir persists and
 * what sendToSession threads to the supervisor as `persistentSession.homeDir`; the
 * supervisor derives the same `agent/` (config run dir) + `cwd/` (stable working dir the
 * CLI keys its session files under, so `--resume` finds them) layout from it — keep the
 * two in lockstep. Like the K namespace, `sessions/` lives deliberately OUTSIDE
 * `agent-runs/` so the boot orphan-sweep (pruneOrphanAgentRuns), which reaps every
 * `agent-runs/<id>` not held by a live run, never deletes persistent session state.
 * Both segments are interpolated into fs paths, so both are segment-checked.
 */
export function agentSessionPaths(
  profileId: string,
  threadId: string,
  dataDir?: string,
): { base: string; runDir: string; cwd: string } {
  assertSafeSegment(profileId, 'session profile id')
  assertSafeSegment(threadId, 'session thread id')
  const base = path.join(dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR, 'sessions', profileId, threadId)
  return { base, runDir: path.join(base, 'agent'), cwd: path.join(base, 'cwd') }
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
