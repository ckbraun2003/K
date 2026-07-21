/**
 * Runtime config store — persisted key/value config over the app_config table,
 * seeded from env on first read and cached in-memory so reads are cheap.
 *
 * Semantics:
 *  - First read: if the key is absent in app_config, fall back to the env-seeded
 *    default (the default is NOT persisted back — returning it is enough).
 *  - set*: writes to app_config AND updates the cache, so the very next getter
 *    reflects the change without a DB round-trip and without a restart.
 *  - __resetConfigCache: exported for tests to force a DB round-trip.
 */

import {
  HomeLayoutSchema, type HomeLayout,
  AutonomySettingsSchema, DEFAULT_AUTONOMY_SETTINGS, type AutonomySettings, type AutonomyPatchBody,
  BackgroundSettingsSchema, DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings,
  FontColorSettingsSchema, DEFAULT_FONT_COLOR_SETTINGS, type FontColorSettings,
} from '@k/shared'
import { configDb, DATA_DIR } from './db.js'
import fs from 'fs'
import path from 'path'

// In-memory cache keyed by app_config.key. Populated lazily on first read or
// eagerly by set*. Never stale unless __resetConfigCache is called.
const cache = new Map<string, string>()

const KEYS = {
  enabled: 'ollama.enabled',
  baseUrl: 'ollama.baseUrl',
  model:   'ollama.model',
  numCtx:  'ollama.numCtx',
} as const

const VOICE_KEYS = {
  enabled: 'voice.enabled',
  baseUrl: 'voice.baseUrl',
  model:   'voice.model',
} as const

const CLAUDE_KEYS = {
  model: 'claude.model',
} as const

/** Read key from cache → DB → env default (in that order). */
function readKey(key: string, envDefault: string): string {
  if (cache.has(key)) return cache.get(key)!
  const stored = configDb.get(key)
  if (stored !== undefined) {
    cache.set(key, stored)
    return stored
  }
  return envDefault
}

// ── Public getters ────────────────────────────────────────────────────────────

export function ollamaEnabled(): boolean {
  const v = readKey(KEYS.enabled, process.env.ENABLE_OLLAMA === 'true' ? 'true' : 'false')
  return v === 'true'
}

export function ollamaBaseUrl(): string {
  return readKey(KEYS.baseUrl, process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434')
}

export function activeOllamaModel(): string {
  return readKey(KEYS.model, process.env.OLLAMA_MODEL ?? 'llama3.2')
}

export const DEFAULT_OLLAMA_NUM_CTX = 16_384

/** The explicit num_ctx for ollama AGENT runs (D-072): app_config
 *  `ollama.numCtx`, seeded from K_OLLAMA_NUM_CTX, defaulting to 16384. A
 *  non-numeric / non-positive stored value degrades to the default. */
export function ollamaNumCtx(): number {
  const raw = readKey(KEYS.numCtx, process.env.K_OLLAMA_NUM_CTX ?? '')
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_OLLAMA_NUM_CTX
}

// ── Public setters ────────────────────────────────────────────────────────────

export function setOllamaNumCtx(v: number): void {
  const s = String(Math.floor(v))
  configDb.set(KEYS.numCtx, s)
  cache.set(KEYS.numCtx, s)
}

export function setOllamaEnabled(v: boolean): void {
  const s = v ? 'true' : 'false'
  configDb.set(KEYS.enabled, s)
  cache.set(KEYS.enabled, s)
}

export function setOllamaBaseUrl(v: string): void {
  configDb.set(KEYS.baseUrl, v)
  cache.set(KEYS.baseUrl, v)
}

export function setActiveOllamaModel(v: string): void {
  configDb.set(KEYS.model, v)
  cache.set(KEYS.model, v)
}

// ── Claude runtime default model ────────────────────────────────────────────────
// Previously an env-frozen `const` read once at router.ts module load. Now
// runtime-managed here (app_config key `claude.model`, seeded from CLAUDE_MODEL)
// so the global Claude default is operator-selectable and hot-swappable — router
// reads it through claudeDefaultModel() at route() call time, never frozen.

export function claudeDefaultModel(): string {
  return readKey(CLAUDE_KEYS.model, process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6')
}

/** Persist the global Claude default model. Callers MUST validate `v` against
 *  `isKnownModel` first — this is enforced at the `PUT /api/claude/model` route
 *  boundary; the store write itself does not gate the value, so any bypassing
 *  call site (a migration, a second route) must run the registry check itself. */
export function setClaudeDefaultModel(v: string): void {
  configDb.set(CLAUDE_KEYS.model, v)
  cache.set(CLAUDE_KEYS.model, v)
}

// ── Voice getters ─────────────────────────────────────────────────────────────

export function voiceEnabled(): boolean {
  const v = readKey(VOICE_KEYS.enabled, process.env.ENABLE_VOICE === 'true' ? 'true' : 'false')
  return v === 'true'
}

export function whisperBaseUrl(): string {
  return readKey(VOICE_KEYS.baseUrl, process.env.WHISPER_BASE_URL ?? 'http://localhost:9000')
}

export function whisperModel(): string {
  return readKey(VOICE_KEYS.model, process.env.WHISPER_MODEL ?? 'whisper-base.en')
}

// ── Voice setters ─────────────────────────────────────────────────────────────

export function setVoiceEnabled(v: boolean): void {
  const s = v ? 'true' : 'false'
  configDb.set(VOICE_KEYS.enabled, s)
  cache.set(VOICE_KEYS.enabled, s)
}

export function setWhisperBaseUrl(v: string): void {
  configDb.set(VOICE_KEYS.baseUrl, v)
  cache.set(VOICE_KEYS.baseUrl, v)
}

export function setWhisperModel(v: string): void {
  configDb.set(VOICE_KEYS.model, v)
  cache.set(VOICE_KEYS.model, v)
}

// ── Home layout ───────────────────────────────────────────────────────────────

/** Read home layout from app_config. Returns null if absent or corrupt. */
export function homeLayout(): HomeLayout | null {
  const raw = configDb.get('home_layout')
  if (!raw) return null
  try {
    const parsed = HomeLayoutSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Persist home layout to app_config. Assumes caller validates via HomeLayoutSchema. */
export function setHomeLayout(layout: HomeLayout): void {
  configDb.set('home_layout', JSON.stringify(layout))
}

// ── Autonomy settings (P5) — one JSON blob in app_config (mirrors home_layout) ──

const AUTONOMY_KEY = 'autonomy.settings'

/** Read persisted autonomy settings, merged over DEFAULT (forward-compatible with
 *  added fields). Absent or corrupt → DEFAULT (default OFF). */
export function autonomySettings(): AutonomySettings {
  const raw = configDb.get(AUTONOMY_KEY)
  if (!raw) return DEFAULT_AUTONOMY_SETTINGS
  try {
    const parsed = AutonomySettingsSchema.safeParse({ ...DEFAULT_AUTONOMY_SETTINGS, ...JSON.parse(raw) })
    return parsed.success ? parsed.data : DEFAULT_AUTONOMY_SETTINGS
  } catch {
    return DEFAULT_AUTONOMY_SETTINGS
  }
}

/** Merge a partial patch onto current settings, validate, persist, return the new value. */
export function setAutonomySettings(patch: AutonomyPatchBody): AutonomySettings {
  const next = AutonomySettingsSchema.parse({ ...autonomySettings(), ...patch })
  configDb.set(AUTONOMY_KEY, JSON.stringify(next))
  return next
}

// ── Background settings (usability-access B.3 → wallpaper settings model) ───────
// Storage note: BG_KEY held a bare BackgroundVariant string pre-migration; the
// legacy values ('galaxy'/'blobs'/'solid'/'aurora') are recognized and mapped
// forward so an existing operator preference survives the upgrade instead of
// silently resetting to default.

const BG_KEY = 'ui.background'

/** Read the operator's background settings. Absent → DEFAULT_BACKGROUND_SETTINGS.
 *  A legacy bare-variant string maps forward (galaxy/blobs/solid → solid,
 *  aurora → gradient/aurora); corrupt/unparseable JSON → default. */
export function backgroundSettings(): BackgroundSettings {
  const raw = configDb.get(BG_KEY)
  if (!raw) return DEFAULT_BACKGROUND_SETTINGS
  if (raw === 'galaxy' || raw === 'blobs' || raw === 'solid') return { kind: 'solid', preset: null, imageVersion: null }
  if (raw === 'aurora') return { kind: 'gradient', preset: 'aurora', imageVersion: null }
  try {
    const parsed = BackgroundSettingsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : DEFAULT_BACKGROUND_SETTINGS
  } catch {
    return DEFAULT_BACKGROUND_SETTINGS
  }
}

/** Persist the background settings. Callers MUST validate `s` at the route
 *  boundary (PUT /api/settings/background) — this store write does not gate it. */
export function setBackgroundSettings(s: BackgroundSettings): void {
  configDb.set(BG_KEY, JSON.stringify(s))
}

// ── Font-colour override (ui-adjustments Round 2) ────────────────────────────
// Lets the operator retune the body text colour when a custom wallpaper clashes
// with the default pale graphite-blue (--text). app_config-backed, NO schema
// bump — mirrors the BackgroundSettings storage pattern exactly (one JSON blob,
// absent/corrupt → default).

const FC_KEY = 'ui.fontColor'

/** Read the operator's font-colour override. Absent → DEFAULT_FONT_COLOR_SETTINGS
 *  (`{ color: null }` — no override, theme default applies). Corrupt/unparseable
 *  JSON or a value failing schema validation also falls back to the default. */
export function fontColorSettings(): FontColorSettings {
  const raw = configDb.get(FC_KEY)
  if (!raw) return DEFAULT_FONT_COLOR_SETTINGS
  try {
    const parsed = FontColorSettingsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : DEFAULT_FONT_COLOR_SETTINGS
  } catch {
    return DEFAULT_FONT_COLOR_SETTINGS
  }
}

/** Persist the font-colour override. Callers MUST validate `s` at the route
 *  boundary (PUT /api/settings/font-color) — this store write does not gate it. */
export function setFontColorSettings(s: FontColorSettings): void {
  configDb.set(FC_KEY, JSON.stringify(s))
}

// ── Wallpaper file storage ───────────────────────────────────────────────────
// The uploaded wallpaper image lives under DATA_DIR (the same gitignored data
// dir the DB/auth-token/system-prompt-backups use), never inside the repo and
// never at a user-controlled path — the route always writes/reads the FIXED
// filename `wallpaper.<ext>` here, so no path segment is ever derived from
// request input.

const WALLPAPER_DIR = path.join(DATA_DIR, 'wallpapers')

/** The directory the uploaded wallpaper image is stored in. Created on demand
 *  (idempotent — mkdir recursive). */
export function wallpaperDir(): string {
  fs.mkdirSync(WALLPAPER_DIR, { recursive: true })
  return WALLPAPER_DIR
}

// ── Test seam ────────────────────────────────────────────────────────────────

/** Reset the in-memory cache so the next getter performs a DB round-trip.
 *  For tests only — do not call in production code. */
export function __resetConfigCache(): void {
  cache.clear()
}
