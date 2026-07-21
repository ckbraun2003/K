/**
 * Settings routes — provider/auth status + the guarded GLOBAL system-prompt
 * (the L0 base operating prompt, agent-config/base-operating-prompt.md) editor.
 *
 * Two design rules drive this file:
 *
 *  1. Testability via injection. The status response is assembled by a PURE
 *     builder (`buildStatus`) that takes already-resolved probe results, so a
 *     unit test asserts the response SHAPE without depending on whether `claude`
 *     or `gh` are installed in CI. The route calls the real subprocess probes and
 *     hands their results to the same builder.
 *
 *  2. No secrets, no traversal. /status never carries the token value (only its
 *     origin). The system-prompt endpoints operate ONLY on a single fixed file
 *     path (no slug, no params) — overridable via SYSTEM_PROMPT_PATH purely so
 *     tests target a temp file instead of the real base operating prompt.
 */

import { execa } from 'execa'
import { randomBytes } from 'crypto'
import { probeTool, CLAUDE_PROBE } from '../system-doctor.js'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  type Status, SystemPromptBodySchema, isKnownModel,
  GRADIENT_PRESETS, BACKGROUND_KINDS, BackgroundSettingsSchema, BackgroundImageUploadSchema,
} from '@k/shared'
import { resolveAvailableModels, availableModelIds } from '../models.js'
import { isOllamaReachable } from '../router.js'
import {
  ollamaEnabled, ollamaBaseUrl, activeOllamaModel, voiceEnabled, whisperBaseUrl, whisperModel,
  backgroundSettings, setBackgroundSettings, wallpaperDir,
} from '../config-store.js'
import { harnessTokenSource, isLoopbackHost } from '../auth.js'
import { credentialPosture, type CredentialPosture } from '../agent-config.js'
import { probeWhisper } from '../transcription.js'
import { GrantError, resolveAuthority } from '../authority.js'
import { getProfile, updateProfile } from '../profiles.js'
import { agentProfilesDb } from '../db.js'
import { ORG_DEFAULT_PROFILE_ID } from '../plan-gate.js'
import { sendError, sendZodError, describePatchRejection } from './http-errors.js'

// ── System-prompt file location ───────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// agent-config is READ-ONLY bundled assets, resolved __dirname-relative so it
// survives packaging (like skills.ts / run-assets.ts). This file lives one level
// deeper than those (core/src/routes → core/dist/routes), so three `..` reach the
// parent of `core` — the repo root in dev, `<resources>/` in the packaged app,
// where prepackage stages `agent-config/`. It must NOT resolve off supervisor's
// REPO_ROOT: under a desktop install that is the WRITABLE per-user runtime dir,
// which seeds no `agent-config/`, so reads would return a blank prompt and writes
// would ENOENT — while the real dispatch path (run-assets.ts) keeps reading the
// bundled file, silently splitting the source of truth.
const ASSETS_ROOT = path.join(__dirname, '../../../')

/** The fixed, global system prompt = the L0 base operating prompt injected into
 *  every K-managed run (agent-config/base-operating-prompt.md). Overridable ONLY
 *  via SYSTEM_PROMPT_PATH so tests can target a temp file (the real path is the
 *  default). No request input ever influences this — no traversal is possible. */
export function systemPromptPath(): string {
  return process.env.SYSTEM_PROMPT_PATH ?? path.join(ASSETS_ROOT, 'agent-config', 'base-operating-prompt.md')
}

// Mirror auth.ts / db.ts: backups live under the gitignored data dir.
const DATA_DIR = process.env.K_DATA_DIR ?? path.join(__dirname, '../../data')
const BACKUP_DIR = path.join(DATA_DIR, 'system-prompt-backups')

// GitNexus may append a managed block to the END of the edited file after a
// commit. The operator never edits it; we preserve it verbatim across saves.
// (The base operating prompt carries no such block — the split handles that fine.)
export const GITNEXUS_START = '<!-- gitnexus:start -->'
export const GITNEXUS_END = '<!-- gitnexus:end -->'

/**
 * Split the edited prompt file into its human-editable region and the trailing,
 * gitnexus-managed block (if present). Pure — the round-trip core of the editor.
 *
 * Both regions are returned with trailing whitespace trimmed so the round-trip is
 * stable (re-saves don't accrete blank lines, and the extracted block compares
 * equal across save cycles). The human region is everything BEFORE the start
 * marker; the block is the start marker through EOF (start..end inclusive, plus
 * anything the analyzer appended after the end marker — preserved verbatim aside
 * from the trailing-whitespace trim). If no start marker, the whole file is human
 * and there is no block.
 */
export function splitSystemPrompt(content: string): { human: string; block: string | null } {
  const startIdx = content.indexOf(GITNEXUS_START)
  if (startIdx === -1) return { human: content.replace(/\s+$/, ''), block: null }
  const human = content.slice(0, startIdx).replace(/\s+$/, '')
  const block = content.slice(startIdx).replace(/\s+$/, '')
  return { human, block }
}

/**
 * Recompose the file from a freshly-submitted human region and a preserved
 * gitnexus block. Pure counterpart to splitSystemPrompt: the human md, then (if
 * a block exists) exactly one blank-line separator, then the block verbatim. The
 * file ends with a trailing newline.
 */
export function composeSystemPrompt(human: string, block: string | null): string {
  const humanPart = human.replace(/\s+$/, '')
  if (!block) return humanPart + '\n'
  return `${humanPart}\n\n${block.replace(/\s+$/, '')}\n`
}

// ── Status: pure builder + real probes ────────────────────────────────────────

export interface StatusProbes {
  claude: { available: boolean; version?: string }
  github: { authenticated: boolean; user?: string }
  whisperReachable: boolean
}

export interface StatusEnv {
  ollamaEnabled: boolean
  ollamaReachable: boolean
  ollamaBaseUrl: string
  ollamaModel: string
  voiceEnabled: boolean
  voiceBaseUrl: string
  voiceModel: string
  tokenSource: 'env' | 'generated'
  host: string
  terminalEnabled: boolean
  credentialPosture: CredentialPosture
}

/** Pure shaping of the /status response from already-resolved probe + env state.
 *  No subprocesses, no secrets — unit-testable with fakes. */
export function buildStatus(probes: StatusProbes, env: StatusEnv): Status {
  return {
    claude: probes.claude,
    ollama: {
      enabled: env.ollamaEnabled,
      reachable: env.ollamaReachable,
      baseUrl: env.ollamaBaseUrl,
      model: env.ollamaModel,
    },
    github: probes.github,
    auth: {
      tokenSource: env.tokenSource,
      host: env.host,
      loopbackOnly: isLoopbackHost(env.host),
      terminalEnabled: env.terminalEnabled,
      credentialPosture: env.credentialPosture,
    },
    voice: {
      enabled: env.voiceEnabled,
      reachable: probes.whisperReachable,
      baseUrl: env.voiceBaseUrl,
      model: env.voiceModel,
    },
  }
}

/** Probe the local `claude` binary — DELEGATES to the shared CLAUDE_PROBE definition
 *  (system-doctor.ts) so /api/status and /api/system/doctor can never disagree on
 *  bin/args/timeout (BE-3b; the old 2s timeout here raced cold shims). */
export async function probeClaude(): Promise<StatusProbes['claude']> {
  const r = await probeTool(CLAUDE_PROBE.bin, [...CLAUDE_PROBE.args], CLAUDE_PROBE.timeoutMs)
  return r.present ? { available: true, version: r.version ?? undefined } : { available: false }
}

/** Probe GitHub auth via `gh auth status` (short timeout). Never throws; returns
 *  authenticated:false if gh is absent / not logged in. Parses the logged-in
 *  account name when gh prints it ("Logged in to github.com account <user>" on
 *  newer gh, or "Logged in to github.com as <user>" on older). */
export async function probeGithub(): Promise<StatusProbes['github']> {
  try {
    // gh writes the human-readable status to stderr; capture both streams.
    const { stdout, stderr } = await execa('gh', ['auth', 'status'], { timeout: 3_000 })
    const text = `${stdout}\n${stderr}`
    const m = text.match(/Logged in to \S+ (?:account|as) (\S+)/)
    return { authenticated: true, user: m ? m[1] : undefined }
  } catch {
    return { authenticated: false }
  }
}

// The status panel polls /api/status every ~30s. Spawning `claude --version` and
// `gh auth status` on every request (and every open tab) is wasteful, so cache the
// probe results for a short window. The pure builder (buildStatus) is unaffected —
// tests call it directly and never hit this cache.
const PROBE_TTL_MS = 15_000
let probeCache: { result: StatusProbes; ts: number } | null = null

async function cachedProbes(): Promise<StatusProbes> {
  if (probeCache && Date.now() - probeCache.ts < PROBE_TTL_MS) return probeCache.result
  const [claude, github, whisperReachable] = await Promise.all([
    probeClaude(),
    probeGithub(),
    voiceEnabled() ? probeWhisper() : Promise.resolve(false),
  ])
  const result: StatusProbes = { claude, github, whisperReachable }
  probeCache = { result, ts: Date.now() }
  return result
}

function liveStatusEnv(): StatusEnv {
  return {
    ollamaEnabled: ollamaEnabled(),
    ollamaReachable: isOllamaReachable(),
    ollamaBaseUrl: ollamaBaseUrl(),
    ollamaModel: activeOllamaModel(),
    voiceEnabled: voiceEnabled(),
    voiceBaseUrl: whisperBaseUrl(),
    voiceModel: whisperModel(),
    tokenSource: harnessTokenSource(),
    host: process.env.HOST ?? '127.0.0.1',
    terminalEnabled: process.env.ENABLE_TERMINAL === 'true',
    credentialPosture: credentialPosture(),
  }
}

// ── Org-default authority ───────────────────────────────────────────────────

// The `default-orchestrator` profile is the ORG-DEFAULT authority: the staff-engineer
// grant each discipline lead inherits unless its own Orchestrator detail overrides it.
// Editing it here means skills/tools/mcp/model only (mirrors the per-lead orchestrators
// PATCH) — tier/charter moves are a separate, guarded concern. `.strict()` so an unknown
// key is a 400; an empty body is rejected below.
const OrgDefaultPatchSchema = z
  .object({
    skills: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    defaultModel: z.string().nullable().optional(), // null = clear to runtime default
    // E-02 (D-084): the org-default tier plan-gate flag — an optional passthrough that
    // mirrors defaultModel. Applied via agentProfilesDb.setProfilePlanGate below
    // (updateProfile owns skills/tools/mcp/model only); the org-default authority is
    // the ONE profile that carries the tier default the operator's dispatches resolve.
    planGate: z.boolean().optional(),
  })
  .strict()

// The two fail-closed client-error guards updateProfile can raise — assertMcpGrants
// (a bad MCP mount, "mounting ≠ granting") and assertTierCeiling (the B1 tier
// ceiling) — throw the typed GrantError (authority.ts); the PATCH below maps it to a
// 400. Anything else is a server fault and must surface as 500. Mirrors
// routes/orchestrators.ts.

/** The durable id of the org-default orchestrator authority (=== the seed row / the
 *  DEFAULT_PROFILE fallback in profiles.ts). */
const ORG_DEFAULT_ID = 'default-orchestrator'

// ── Background wallpaper (usability-access B.3 → wallpaper settings model) ──────
// The uploaded wallpaper is stored on disk as a FIXED filename `wallpaper.<ext>`
// under wallpaperDir() (core/src/config-store.ts) — never a request-derived path,
// so there is no traversal surface. mime<->ext is a small closed map (png/jpeg/
// webp only); anything else is rejected by BackgroundImageUploadSchema before we
// ever touch the bytes.

const MIME_TO_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const EXT_TO_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024 // 25 MB (decoded) — HD/4K wallpapers (ui-adjustments C5)
// Fastify's default bodyLimit is 1 MiB — far below a 25 MB image's base64
// footprint (~4/3 expansion) once wrapped in the { dataUrl } JSON envelope. Cap
// this route's request body generously above that (~35 MB) so oversize requests
// reach the handler's decoded-size check (→ a clean 400) instead of a raw 413
// from the transport layer; still bounded, not unlimited. Derived from
// MAX_WALLPAPER_BYTES so the two caps can never drift.
const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_WALLPAPER_BYTES * 4) / 3) + 2 * 1024 * 1024

/** Remove any existing `wallpaper.*` file in dir (best-effort — a stale second
 *  extension from a prior upload of a different format must never linger). */
async function clearExistingWallpaper(dir: string): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter(f => f.startsWith('wallpaper.'))
      .map(f => fs.unlink(path.join(dir, f)).catch(() => {})),
  )
}

/** Find the currently-stored wallpaper file (fixed basename, one of the three
 *  known extensions). Returns null if none is present. */
async function findWallpaperFile(dir: string): Promise<{ file: string; ext: string } | null> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const found = entries.find(f => f.startsWith('wallpaper.') && EXT_TO_MIME[f.split('.').pop() ?? ''])
  if (!found) return null
  return { file: found, ext: found.split('.').pop()! }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/status — provider availability + auth posture (no secrets).
  app.get('/api/status', async (_req, reply) => {
    return reply.send(buildStatus(await cachedProbes(), liveStatusEnv()))
  })

  // GET /api/settings/background — the operator's background settings + the
  // full preset/kind lists (so the client never hardcodes the options).
  app.get('/api/settings/background', async (_req, reply) =>
    reply.send({ settings: backgroundSettings(), presets: GRADIENT_PRESETS, kinds: BACKGROUND_KINDS }))

  // PUT /api/settings/background — set kind + preset. imageVersion is preserved
  // (it is only ever advanced by the image-upload route below). Selecting
  // kind:'image' with no wallpaper on disk is rejected — the client can never
  // point the app at an image that doesn't exist.
  app.put('/api/settings/background', async (req, reply) => {
    const parsed = BackgroundSettingsSchema.pick({ kind: true, preset: true }).safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error, 'invalid background settings')

    const prev = backgroundSettings()
    if (parsed.data.kind === 'image') {
      const existing = await findWallpaperFile(wallpaperDir())
      if (!existing) return sendError(reply, 400, 'no image uploaded')
    }

    const next = { ...parsed.data, imageVersion: prev.imageVersion }
    setBackgroundSettings(next)
    return reply.send({ settings: next })
  })

  // PUT /api/settings/background/image — upload a wallpaper image as a data:
  // URL. Validated + size-capped before any bytes are decoded; written to a
  // FIXED filename under wallpaperDir() (no request-derived path segment).
  app.put('/api/settings/background/image', { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (req, reply) => {
    const parsed = BackgroundImageUploadSchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error, 'invalid image upload')

    const match = parsed.data.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
    if (!match) return sendError(reply, 400, 'invalid image upload')
    const [, mime, b64] = match
    const ext = MIME_TO_EXT[mime]
    if (!ext) return sendError(reply, 400, 'unsupported image type')

    const buf = Buffer.from(b64, 'base64')
    if (buf.length > MAX_WALLPAPER_BYTES) return sendError(reply, 400, 'image too large')

    const dir = wallpaperDir()
    await clearExistingWallpaper(dir)
    await fs.writeFile(path.join(dir, `wallpaper.${ext}`), buf)

    const prev = backgroundSettings()
    const next = { kind: 'image' as const, preset: null, imageVersion: (prev.imageVersion ?? 0) + 1 }
    setBackgroundSettings(next)
    return reply.send({ settings: next })
  })

  // GET /api/settings/background/image — serve the currently-stored wallpaper
  // bytes. 404 when none has been uploaded.
  app.get('/api/settings/background/image', async (_req, reply) => {
    const found = await findWallpaperFile(wallpaperDir())
    if (!found) return sendError(reply, 404, 'no image uploaded')
    const bytes = await fs.readFile(path.join(wallpaperDir(), found.file))
    return reply.header('cache-control', 'no-cache').type(EXT_TO_MIME[found.ext]).send(bytes)
  })

  // GET /api/system-prompt — the human-editable region of the prompt file only.
  app.get('/api/system-prompt', async (_req, reply) => {
    let content = ''
    try {
      content = await fs.readFile(systemPromptPath(), 'utf8')
    } catch {
      // First-ever read / missing file → empty human region (not an error).
      content = ''
    }
    return reply.send({ md: splitSystemPrompt(content).human })
  })

  // PUT /api/system-prompt — replace the human region, preserve the gitnexus
  // block, back up the prior file. Schema-locked body (extra key / oversize → 400).
  app.put('/api/system-prompt', async (req, reply) => {
    const parsed = SystemPromptBodySchema.safeParse(req.body)
    if (!parsed.success) return sendZodError(reply, parsed.error)

    // The human region must never contain the gitnexus block markers: a stray
    // start/end marker would be re-classified as "block" on the next GET, silently
    // swallowing everything after it. Reject rather than corrupt the round-trip.
    if (parsed.data.md.includes(GITNEXUS_START) || parsed.data.md.includes(GITNEXUS_END)) {
      return sendError(reply, 400, 'The system prompt body must not contain gitnexus block markers.')
    }

    const target = systemPromptPath()

    // Re-read the CURRENT file to (a) preserve any gitnexus block and (b) back it
    // up before overwrite. A missing file (first-ever save) is fine — no block,
    // no backup. Only genuine read failures are tolerated; we never block the save.
    let current: string | null = null
    try {
      current = await fs.readFile(target, 'utf8')
    } catch {
      current = null
    }

    // Best-effort backup of the prior content (only if there was prior content).
    if (current !== null) {
      try {
        await fs.mkdir(BACKUP_DIR, { recursive: true })
        await fs.writeFile(path.join(BACKUP_DIR, `${Date.now()}.md`), current, 'utf8')
        // Bound backup growth: keep only the most recent 50. Names are Date.now()
        // based, so lexicographic sort == chronological. Best-effort.
        try {
          const files = (await fs.readdir(BACKUP_DIR)).filter(f => f.endsWith('.md')).sort()
          if (files.length > 50) {
            await Promise.all(
              files
                .slice(0, files.length - 50)
                .map(f => fs.unlink(path.join(BACKUP_DIR, f)).catch(() => {})),
            )
          }
        } catch { /* trim is best-effort — never fail the save */ }
      } catch (e) {
        app.log.warn(`[settings] system-prompt backup failed: ${e instanceof Error ? e.message : e}`)
      }
    }

    const block = current === null ? null : splitSystemPrompt(current).block
    const composed = composeSystemPrompt(parsed.data.md, block)

    // Atomic write: write to a sibling temp file then rename over the target, so a
    // failed/partial write can never truncate the prompt file to empty. The backup above
    // still holds the prior content if anything here throws. (rename is atomic on
    // POSIX and clobbers on Windows same-volume.)
    const tmp = `${target}.tmp.${randomBytes(4).toString('hex')}`
    try {
      await fs.writeFile(tmp, composed, 'utf8')
      await fs.rename(tmp, target)
    } catch (e) {
      await fs.unlink(tmp).catch(() => {})
      app.log.error(`[settings] system-prompt write failed: ${e instanceof Error ? e.message : e}`)
      return sendError(reply, 500, 'Failed to write system prompt.')
    }

    return reply.send({ savedAt: Date.now() })
  })

  // GET /api/org-default — the org-default orchestrator authority (default-orchestrator),
  // the grant each discipline lead inherits. 404 only if the profile is unseeded (shouldn't
  // happen post-seed).
  app.get('/api/org-default', async (_req, reply) => {
    const profile = getProfile(ORG_DEFAULT_ID)
    if (!profile) return sendError(reply, 404, 'not found')
    return reply.send(profile)
  })

  // PATCH /api/org-default — edit the org-default authority (skills/tools/mcp/model). Mirrors
  // the per-lead orchestrators PATCH grant-guard pattern EXACTLY: validate (400), reject empty
  // (400), then updateProfile under the grant guard. SEAM: the guard's throw ("mounting ≠
  // granting") → 400 (never bypassed); any OTHER throw re-throws (→ Fastify 500); a null return
  // (unseeded) → 404.
  app.patch('/api/org-default', async (req, reply) => {
    const parsed = OrgDefaultPatchSchema.safeParse(req.body)
    // Name the offending field(s) (F-024) — a tier/charter move hears WHY it was rejected.
    if (!parsed.success) return sendError(reply, 400, describePatchRejection(parsed.error, ['tier', 'charter']))
    if (Object.keys(parsed.data).length === 0) {
      return sendError(reply, 400, 'empty patch')
    }
    // defaultModel must be an available model id — Claude KNOWN_MODELS ∪ whatever
    // Ollama models are actually installed (usability-access C.2; was Claude-only
    // isKnownModel). null explicitly CLEARS the override back to the runtime
    // default. '' normalizes to that same clear-sentinel FIRST — it is the storage
    // encoding of "no override" (db.ts rowToAgentProfile), so it must clear, never 400.
    if (parsed.data.defaultModel === '') parsed.data.defaultModel = null
    // Short-circuit the common Claude-id path (SEAMS#1 follow-up) — a known model
    // never waits on the Ollama round-trip resolveAvailableModels() makes.
    if (parsed.data.defaultModel != null && !isKnownModel(parsed.data.defaultModel)) {
      const avail = availableModelIds(await resolveAvailableModels())
      if (!avail.has(parsed.data.defaultModel)) return sendError(reply, 400, 'unknown model')
    }
    // Skills must exist in the tier's authored skill set (F-049). The tier bundle is
    // the synthesizer's CEILING — agent-config.ts throws at DISPATCH time on a profile
    // skill outside it. Validate here at the edit boundary so an unregistered skill
    // gets a clear 400 instead of being stored silently and breaking the next run.
    if (parsed.data.skills) {
      const profile = getProfile(ORG_DEFAULT_ID)
      if (!profile) return sendError(reply, 404, 'not found')
      const available = new Set(resolveAuthority(profile.tier).skills)
      const unknown = parsed.data.skills.filter(s => !available.has(s))
      if (unknown.length > 0) {
        return sendError(
          reply,
          400,
          `unknown skill(s): ${unknown.join(', ')} — not in the ${profile.tier} tier skill set`,
        )
      }
    }
    try {
      // E-02 (D-084): updateProfile owns skills/tools/mcp/model only; the plan_gate
      // column is written by its dedicated setter. Write it ONLY AFTER updateProfile
      // succeeds — updateProfile validates authority (assertEffectiveGrants) and
      // throws GrantError → 400 on a rejected patch; writing plan_gate first would
      // flip the org-wide plan-gate default even though the API tells the operator the
      // request was rejected. Reflect the new flag on the returned payload so it still
      // matches a fresh rowToAgentProfile read (0 → undefined).
      const { planGate, ...profilePatch } = parsed.data
      const updated = updateProfile(ORG_DEFAULT_ID, profilePatch)
      if (!updated) return sendError(reply, 404, 'not found')
      if (planGate !== undefined) {
        agentProfilesDb.setProfilePlanGate.run(planGate ? 1 : 0, ORG_DEFAULT_PROFILE_ID)
        updated.planGate = planGate ? true : undefined
      }
      return reply.send(updated)
    } catch (e) {
      // Typed guard signal → 400 with the message verbatim; anything else → 500.
      if (e instanceof GrantError) return sendError(reply, 400, e.message)
      throw e
    }
  })
}
