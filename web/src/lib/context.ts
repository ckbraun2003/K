import type { AgentEvent } from '@k/shared'
import { modelContextWindow } from '@k/shared'

/**
 * Pure helpers for the per-run context-pressure indicator (Wave D6).
 *
 * The enriched parser (Wave D3/D6) carries `contextTokens` on each assistant /
 * usage event — the full input context size for that turn (fresh input_tokens +
 * cache_creation_input_tokens + cache_read_input_tokens), distinct from
 * `tokensIn` (fresh input only). We track the latest turn's context size against
 * the model's context window and bucket it into a warning band. Everything here
 * is defensive and never throws — a malformed event must not crash the header.
 */

/** Percent of the context window at/above which we warn (amber). */
export const CONTEXT_WARN_PCT = 70
/** Percent of the context window at/above which we flag danger (red). */
export const CONTEXT_DANGER_PCT = 90

export type ContextBand = 'ok' | 'warn' | 'danger' | 'unknown'

export interface ContextPressure {
  /** Latest-turn input context size in tokens. */
  tokens: number
  /** Model context window in tokens, or undefined for unknown/local models. */
  limit: number | undefined
  /** tokens/limit as a 0..100 percent, or undefined when the limit is unknown. */
  percent: number | undefined
  band: ContextBand
}

/**
 * The most recent turn's context size. Scans for the event with the HIGHEST
 * `seq` carrying a context signal (rather than trusting array order), returning
 * its `contextTokens` (preferred), else `tokensIn`, else 0. Returns 0 when no
 * event carries either signal. Never throws.
 *
 * Only `assistant` events are considered — they carry the per-turn context size
 * (fresh input + cache, for that ONE turn). The final `result` line maps to a
 * `usage` event whose token totals are RUN-CUMULATIVE (and, on a multi-agent run,
 * fold in subagent usage), so counting it made the meter read the whole-run sum
 * against the single-turn 200k window — e.g. `ctx 245k/200k` on a run that peaked
 * at ~18%, or `ctx 449k/200k` when subagent tokens were summed (F-056 / F-073).
 * Excluding non-assistant events keeps the meter on the true single-turn value
 * that is already correct live (before the cumulative `result` event lands).
 */
export function latestContextTokens(events: AgentEvent[]): number {
  let bestSeq = -Infinity
  let bestTokens = 0
  for (const e of events ?? []) {
    if (e == null) continue
    // The context window is a single-turn window: only per-turn assistant events
    // report it. Skip the cumulative `usage`/`result` event (and any non-turn row).
    if (e.type !== 'assistant') continue
    const raw = e.contextTokens ?? e.tokensIn
    // Ignore malformed (non-numeric) signals so a bad event can't poison the read.
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const seq = typeof e.seq === 'number' ? e.seq : -Infinity
    // Strictly greater so the HIGHEST seq wins and the FIRST event wins on a tie.
    if (seq > bestSeq) {
      bestSeq = seq
      bestTokens = raw
    }
  }
  return bestTokens
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Derive context pressure from a run's events + model. With an unknown model
 * (or no model) the limit/percent are undefined and the band is `'unknown'`;
 * otherwise the percent is clamped to 0..100 and bucketed into ok/warn/danger.
 */
export function contextPressure(events: AgentEvent[], model?: string): ContextPressure {
  const tokens = latestContextTokens(events)
  const limit = model ? modelContextWindow(model) : undefined
  if (limit == null) {
    return { tokens, limit: undefined, percent: undefined, band: 'unknown' }
  }
  const percent = clamp((tokens / limit) * 100, 0, 100)
  const band: ContextBand =
    percent >= CONTEXT_DANGER_PCT ? 'danger' : percent >= CONTEXT_WARN_PCT ? 'warn' : 'ok'
  return { tokens, limit, percent, band }
}

// ─── Auto-compaction debounce (pure, hysteresis) ──────────────────────────────

/** Whether auto-compaction is allowed to fire on the next danger episode. */
export interface AutoCompactState {
  armed: boolean
}

export interface AutoCompactInputs {
  band: ContextBand        // from contextPressure
  awaiting: boolean        // run.status === 'awaiting_input'
  interactive: boolean     // run is an interactive session
  sending: boolean         // a send is already in flight
  operatorTyping: boolean  // the answer textarea has non-empty trimmed text
}

/**
 * Hysteresis debounce for auto-`/compact`: fire at most once per danger episode,
 * and re-arm only after context recovers to `'ok'`. Never fires if the run isn't
 * interactive, isn't parked at `awaiting_input`, a send is already in flight, or
 * the operator is mid-answer. Pure — no side effects; the caller holds `state`
 * in a ref and applies the returned `fire`.
 *
 * - Re-arm: `band === 'ok'` → `armed = true` (fire stays false).
 * - Fire: `prev.armed && band === 'danger' && awaiting && interactive &&
 *   !sending && !operatorTyping` → `fire = true`, `armed = false` (so it won't
 *   loop even if `/compact` fails to drop below danger).
 * - Otherwise: `fire = false`, `armed` carried unchanged.
 */
export function nextAutoCompact(
  prev: AutoCompactState,
  i: AutoCompactInputs,
): { state: AutoCompactState; fire: boolean } {
  // Re-arm once context has recovered to a healthy band.
  if (i.band === 'ok') return { state: { armed: true }, fire: false }
  // Fire once per danger episode, but only when it's safe to take the turn.
  if (prev.armed && i.band === 'danger' && i.awaiting && i.interactive && !i.sending && !i.operatorTyping) {
    return { state: { armed: false }, fire: true }
  }
  // Warn / unknown / disarmed / unsafe-to-fire: hold the current arm state.
  return { state: { armed: prev.armed }, fire: false }
}
