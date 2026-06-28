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
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { FastifyInstance } from 'fastify'
import { type Status, SystemPromptBodySchema } from '@k/shared'
import { REPO_ROOT } from '../supervisor.js'
import { isOllamaReachable } from '../router.js'
import { harnessTokenSource, isLoopbackHost } from '../auth.js'

// ── System-prompt file location ───────────────────────────────────────────────

/** The fixed, global system prompt = the L0 base operating prompt injected into
 *  every K-managed run (agent-config/base-operating-prompt.md). Overridable ONLY
 *  via SYSTEM_PROMPT_PATH so tests can target a temp file (the real path is the
 *  default). No request input ever influences this — no traversal is possible. */
export function systemPromptPath(): string {
  return process.env.SYSTEM_PROMPT_PATH ?? path.join(REPO_ROOT, 'agent-config', 'base-operating-prompt.md')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
}

export interface StatusEnv {
  ollamaEnabled: boolean
  ollamaReachable: boolean
  ollamaBaseUrl: string
  ollamaModel: string
  tokenSource: 'env' | 'generated'
  host: string
  terminalEnabled: boolean
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
    },
  }
}

/** Probe the local `claude` binary via `--version` (short timeout). Never throws. */
export async function probeClaude(): Promise<StatusProbes['claude']> {
  try {
    const { stdout } = await execa('claude', ['--version'], { timeout: 2_000 })
    return { available: true, version: stdout.trim() || undefined }
  } catch {
    return { available: false }
  }
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
  const [claude, github] = await Promise.all([probeClaude(), probeGithub()])
  const result: StatusProbes = { claude, github }
  probeCache = { result, ts: Date.now() }
  return result
}

function liveStatusEnv(): StatusEnv {
  return {
    ollamaEnabled: process.env.ENABLE_OLLAMA === 'true',
    ollamaReachable: isOllamaReachable(),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'llama3.2',
    tokenSource: harnessTokenSource(),
    host: process.env.HOST ?? '127.0.0.1',
    terminalEnabled: process.env.ENABLE_TERMINAL === 'true',
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/status — provider availability + auth posture (no secrets).
  app.get('/api/status', async (_req, reply) => {
    return reply.send(buildStatus(await cachedProbes(), liveStatusEnv()))
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
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    // The human region must never contain the gitnexus block markers: a stray
    // start/end marker would be re-classified as "block" on the next GET, silently
    // swallowing everything after it. Reject rather than corrupt the round-trip.
    if (parsed.data.md.includes(GITNEXUS_START) || parsed.data.md.includes(GITNEXUS_END)) {
      return reply
        .status(400)
        .send({ error: 'The system prompt body must not contain gitnexus block markers.' })
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
      return reply.status(500).send({ error: 'Failed to write system prompt.' })
    }

    return reply.send({ savedAt: Date.now() })
  })
}
