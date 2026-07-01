/**
 * ModelRouter — the routing half of the ModelRouter B-seam.
 *
 * route(task) returns { provider, model, baseUrl? } so the supervisor never has
 * a hard dependency on "claude". Swapping in Ollama for cheap/offline tasks is a
 * config decision, not a code change.
 *
 * Graceful-degradation contract: Ollama is optional. route() only ever selects
 * ollama when it is explicitly enabled (ENABLE_OLLAMA) AND a background probe has
 * confirmed it is reachable. Otherwise it falls back to claude — a routing
 * decision must never make a run *fail* for lack of a local model (the same
 * posture the GitHub poller takes when `gh` is absent).
 *
 * Cost-aware routing reads run-outcome data (mean cost of completed claude runs)
 * so a task with a tight `maxCostUsd` cap can prefer the free local model.
 */

import { db } from './db.js'
import { ollamaEnabled, ollamaBaseUrl, activeOllamaModel, claudeDefaultModel } from './config-store.js'

export type RoutingTask = {
  prompt: string
  preferLocal?: boolean   // hint: route to Ollama if available
  maxCostUsd?: number     // hint: prefer the free local model if claude historically costs more
}

export type RouteResult = {
  provider: 'claude' | 'ollama'
  model: string
  baseUrl?: string  // used for ollama: http://localhost:11434
}

// The Claude default model is no longer an env-frozen module const — it is read
// at call time from the config-store getter (claudeDefaultModel), so an operator
// changing it in Settings applies to the very next run with no restart.

// Reachability is updated by the background probe. It defaults to false so the
// router never routes to an unproven Ollama before the first successful probe.
let ollamaReachable = false
export function isOllamaReachable(): boolean { return ollamaReachable }

/** Injectable decision inputs — supplied in tests to keep route() pure (no DB,
 *  no env, no live probe). Defaults read module/env/DB state in production. */
export type RouteDeps = {
  enableOllama?: boolean
  ollamaReachable?: boolean
  avgClaudeCostUsd?: () => number | null
  claudeDefaultModel?: () => string
}

export function route(task: RoutingTask, deps: RouteDeps = {}): RouteResult {
  const claude: RouteResult = { provider: 'claude', model: (deps.claudeDefaultModel ?? claudeDefaultModel)() }

  const enabled = deps.enableOllama ?? ollamaEnabled()
  if (!enabled) return claude

  const reachable = deps.ollamaReachable ?? ollamaReachable
  if (!reachable) return claude   // degrade — never fail a run for an absent local model

  const ollama: RouteResult = { provider: 'ollama', model: activeOllamaModel(), baseUrl: ollamaBaseUrl() }

  // Explicit hint wins.
  if (task.preferLocal) return ollama

  // Cost-aware: if a cap is set and claude has historically cost more than the
  // cap, prefer the free local model.
  if (task.maxCostUsd != null) {
    const avg = (deps.avgClaudeCostUsd ?? avgClaudeCostUsd)()
    if (avg != null && avg > task.maxCostUsd) return ollama
  }

  return claude
}

/** Run-outcome data: mean cost of completed, non-free claude runs (null if none). */
export function avgClaudeCostUsd(): number | null {
  try {
    const row = db
      .prepare(
        `SELECT AVG(cost_usd) AS avg FROM runs
         WHERE provider = 'claude' AND status = 'done' AND cost_usd > 0`,
      )
      .get() as { avg: number | null } | undefined
    return row?.avg ?? null
  } catch {
    return null
  }
}

/** Probe Ollama reachability via HTTP GET /api/tags. Never throws; updates the
 *  cached flag and returns it. */
export async function probeOllama(baseUrl = ollamaBaseUrl(), timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    ollamaReachable = res.ok
  } catch {
    ollamaReachable = false
  }
  return ollamaReachable
}

/** Start periodic reachability probing. No-op unless ENABLE_OLLAMA is set, so a
 *  machine without Ollama never logs probe noise. Wired into core bootstrap. */
export function startOllamaProbe(intervalMs = 60_000): void {
  if (!ollamaEnabled()) return
  void probeOllama()
  const timer = setInterval(() => { void probeOllama() }, intervalMs)
  timer.unref?.()
}
