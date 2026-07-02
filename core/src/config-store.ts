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

import { configDb } from './db.js'

// In-memory cache keyed by app_config.key. Populated lazily on first read or
// eagerly by set*. Never stale unless __resetConfigCache is called.
const cache = new Map<string, string>()

const KEYS = {
  enabled: 'ollama.enabled',
  baseUrl: 'ollama.baseUrl',
  model:   'ollama.model',
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

// ── Public setters ────────────────────────────────────────────────────────────

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

// ── Test seam ────────────────────────────────────────────────────────────────

/** Reset the in-memory cache so the next getter performs a DB round-trip.
 *  For tests only — do not call in production code. */
export function __resetConfigCache(): void {
  cache.clear()
}
