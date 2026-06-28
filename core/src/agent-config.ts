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
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentProfile } from './profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')
// Mirrors claude-args / db DATA_DIR: env override, else repo-root data/.
const DEFAULT_DATA_DIR = path.join(__dirname, '../../data')

export interface SynthesizedConfig {
  configDir: string                 // → CLAUDE_CONFIG_DIR for the spawn
  allowedTools: string[]            // → claude --allowedTools
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
}

// ── path guard ─────────────────────────────────────────────────────────────────

/** Throw unless `abs` stays at or under `root` (scaffold.ts guard pattern). */
function guardUnder(root: string, abs: string): void {
  // `sep` is '' when root already ends in a separator (e.g. a drive root "C:\").
  const sep = root.endsWith(path.sep) ? '' : path.sep
  if (abs !== root && !abs.startsWith(root + sep)) {
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

// ── public API ───────────────────────────────────────────────────────────────

export function synthesizeConfigDir(profile: AgentProfile, opts: SynthesizeOpts): SynthesizedConfig {
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const dataDir = opts.dataDir ?? process.env.K_DATA_DIR ?? DEFAULT_DATA_DIR
  const hostCredentialsPath =
    opts.hostCredentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json')
  const charter = profile.charterTier

  // Reject traversal in the run id (controls runDir + cleanup's rmSync) and the
  // tier asset name (interpolated into asset read paths) before any fs use.
  assertSafeSegment(opts.runId, 'runId')
  assertSafeSegment(charter, 'charterTier')

  // 1. run config dir (path-guarded root for every write below)
  const runDir = path.join(dataDir, 'agent-runs', opts.runId)
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

  // 4 & 5. vendor skills/ and hooks/ into the run dir.
  copyDirGuarded(configDir, path.join(assetsDir, 'skills'), path.join(configDir, 'skills'))
  copyDirGuarded(configDir, path.join(assetsDir, 'hooks'), path.join(configDir, 'hooks'))

  // 6. MCP config for the tier → mcp.json.
  const mcpConfigPath = path.join(configDir, 'mcp.json')
  guardedCopy(configDir, path.join(assetsDir, 'mcp', `${charter}.json`), mcpConfigPath)

  // 7. allowlist for the tier.
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'allowlists', `${charter}.json`), 'utf8'),
  ) as { allowedTools: string[] }
  const allowedTools = allowlist.allowedTools

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

  // 9. cleanup removes the whole run dir (config + any siblings).
  const cleanup = (): void => {
    fs.rmSync(runDir, { recursive: true, force: true })
  }

  return {
    configDir,
    allowedTools,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile,
    authEnv,
    usedHostCredentialFallback,
    cleanup,
  }
}
