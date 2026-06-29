/**
 * QUARANTINE — CONFIRMED FAULT S5-001 (RED by design).
 * Finding: testing/findings/S5-supervisor-providers-routing.md → row S5-001.
 *
 * Surface: core/src/supervisor.ts `startRun` (line ~111) + core/src/router.ts `route`.
 *
 * Defect: startRun guards the local-model preference ONLY via
 *   `preferLocal: opts.model ? false : opts.preferLocal`
 * but forwards `maxCostUsd: opts.maxCostUsd` UNCONDITIONALLY. When an explicit
 * Claude model id is supplied together with a `maxCostUsd` cap, the cost-aware
 * branch in route() (router.ts:64-67) still fires: if the historical avg claude
 * cost exceeds the cap (and Ollama is enabled + reachable) route() returns
 * `{provider:'ollama'}`. startRun then sets `run.model = opts.model ?? routeResult.model`,
 * i.e. the Claude id — so runAgent dispatches `getProvider('ollama').buildArgs(prompt,
 * {model:'claude-sonnet-4-6'})` → **`ollama run claude-sonnet-4-6`**.
 *
 * This directly contradicts the invariant documented at supervisor.ts:108-110:
 * "An explicitly-named model is always a Claude model id ... it overrides any
 * local-model preference — never route an explicit `claude-*` id to
 * `ollama run <id>`." The `preferLocal:false` guard does not neutralize the cost
 * path.
 *
 * This test reproduces the fault by calling the REAL route() with the EXACT
 * argument shape startRun derives from StartRunOptions (mirrored in
 * `routeArgsFromStartRun` below), then applying startRun's `run.model` rule.
 *
 * EXPECTED (post-fix, e.g. startRun also gating maxCostUsd on opts.model, or
 * short-circuiting to claude whenever opts.model is set): an explicit Claude
 * model never selects the ollama provider → test goes green, moves to gating.
 * ACTUAL (today): route() returns ollama with a claude-* model → RED.
 *
 * Document-only: imports the real router; does not edit core/src/**.
 */
import { describe, it, expect } from 'vitest'
import { route, type RoutingTask, type RouteDeps } from '../../src/router.js'

type StartRunOptions = { model?: string; preferLocal?: boolean; maxCostUsd?: number }

/** Mirrors supervisor.ts:111 — how startRun maps options into route()'s task. */
function routeArgsFromStartRun(prompt: string, opts: StartRunOptions): RoutingTask {
  return { prompt, preferLocal: opts.model ? false : opts.preferLocal, maxCostUsd: opts.maxCostUsd }
}

// Ollama enabled + reachable, and claude historically costs MORE than the cap.
const OLLAMA_UP_PRICEY: RouteDeps = { enableOllama: true, ollamaReachable: true, avgClaudeCostUsd: () => 6 }

describe('S5-001 — explicit Claude model + maxCostUsd must never dispatch to ollama (RED)', () => {
  it('an explicit claude model with a cost cap stays on the claude provider', () => {
    const opts: StartRunOptions = { model: 'claude-sonnet-4-6', maxCostUsd: 5 }
    const res = route(routeArgsFromStartRun('do a thing', opts), OLLAMA_UP_PRICEY)

    // EXPECTED-SAFE: the explicit Claude model id overrides cost-aware local routing.
    // ACTUAL today: res.provider === 'ollama' → this assertion fails (red).
    expect(res.provider).toBe('claude')
  })

  it('the dispatched (provider, model) pair is never {ollama, claude-*}', () => {
    const opts: StartRunOptions = { model: 'claude-opus-4-8', maxCostUsd: 0.01 }
    const res = route(routeArgsFromStartRun('x', opts), OLLAMA_UP_PRICEY)
    const dispatchedModel = opts.model ?? res.model // startRun's run.model rule

    // A claude model id must never be the target of `ollama run <model>`.
    const claudeIdOnOllama = res.provider === 'ollama' && /^claude/.test(dispatchedModel)
    expect(claudeIdOnOllama).toBe(false)
  })
})
