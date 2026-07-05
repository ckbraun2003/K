/**
 * Model capability policy (D-072, wave B4) — decides whether an Ollama model
 * gets the TOOL loop or the prompt-only degrade, truthfully and cheaply.
 *
 * Verdict ladder:
 *   1. /api/show `capabilities` present → 'tools' membership IS the verdict
 *      (cached for the process lifetime).
 *   2. capabilities missing (older daemon) → OPTIMISTIC: attempt tools once;
 *      the loop downgrades via markModelToolUnsupported when the daemon
 *      rejects with the does-not-support-tools 400 (downgrade is cached too,
 *      so the next run of that model degrades up front).
 *   3. /api/show unreachable → optimistic attempt, NOT cached (transient).
 *
 * A NO-TOOLS model NEVER silently falls back to claude — the run degrades IN
 * PLACE to a prompt-only chat with skills inlined (loop.ts), and the run-start
 * system event declares toolSupport=false so the console badge stays honest.
 *
 * The cache is invalidated on a successful pull (routes/ollama.ts) — a
 * re-pulled model may gain or lose tool support with the same name.
 */

import { OllamaTransportError, type OllamaChatTransport } from './transport.js'

export interface ModelCapability {
  toolSupport: boolean
  /** Model context window from /api/show model_info — feeds the loop's
   *  context-pressure warning. */
  contextLength?: number
  source: 'show-capabilities' | 'show-missing' | 'show-unreachable'
}

// Per-model verdicts for the PROCESS lifetime (invalidated on pull).
const cache = new Map<string, ModelCapability>()

export async function resolveModelCapability(
  model: string,
  transport: OllamaChatTransport,
): Promise<ModelCapability> {
  const hit = cache.get(model)
  if (hit) return hit
  try {
    const res = await transport.show(model)
    const cap: ModelCapability = res.capabilities.length > 0
      ? {
          toolSupport: res.capabilities.includes('tools'),
          contextLength: res.contextLength,
          source: 'show-capabilities',
        }
      : {
          // Old daemon (no capabilities field): optimistic try-once. Cached —
          // the loop's markModelToolUnsupported downgrades this entry on the 400.
          toolSupport: true,
          contextLength: res.contextLength,
          source: 'show-missing',
        }
    // A verdict that landed WHILE this probe was in flight wins — in particular
    // a concurrent run's markModelToolUnsupported downgrade must never be
    // clobbered back to optimistic by a stale probe.
    const raced = cache.get(model)
    if (raced) return raced
    cache.set(model, cap)
    return cap
  } catch {
    // show failed outright — transient (daemon hiccup). Attempt tools, do NOT
    // cache: the next run re-probes.
    return { toolSupport: true, source: 'show-unreachable' }
  }
}

/** Pin a model as tool-less after the daemon's does-not-support-tools 400 so
 *  every later run of it degrades up front instead of re-tripping the 400. */
export function markModelToolUnsupported(model: string): void {
  const prev = cache.get(model)
  cache.set(model, {
    toolSupport: false,
    contextLength: prev?.contextLength,
    source: prev?.source ?? 'show-missing',
  })
}

/** Invalidate a model's cached verdict (successful pull may change the model
 *  behind the name). Covers the implicit `:latest` tag alias both ways. */
export function invalidateModelCapability(model: string): void {
  cache.delete(model)
  if (model.endsWith(':latest')) cache.delete(model.slice(0, -':latest'.length))
  else cache.delete(`${model}:latest`)
}

/** Test seam — the cache is process-lifetime by design. */
export function __resetModelCapabilityCache(): void {
  cache.clear()
}

/** The daemon's "model does not support tools" rejection: HTTP 400 whose body
 *  (or message) says so. Anything else is a real failure, not a degrade cue. */
export function isToolUnsupportedError(err: unknown): boolean {
  if (!(err instanceof OllamaTransportError) || err.status !== 400) return false
  return /does not support tools/i.test(`${err.body ?? ''} ${err.message}`)
}
