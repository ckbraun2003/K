/**
 * Event constructors for the Ollama agent loop (D-072) — every event the loop
 * emits is built here, shaped to match what parseClaudeLine (providers.ts)
 * produces for claude runs, so the ENTIRE downstream surface — AgentEventSchema
 * validation, event persistence, the WS stream, pairToolCalls / the run
 * console, usage accumulation (supervisor.accumulate), metrics and routing —
 * works on ollama agent runs with ZERO changes:
 *
 *   - ONE `assistant` event per tool_call, carrying tool / toolUseId /
 *     toolKind (via classifyTool — same table as claude) / toolInput;
 *   - ONE `user` event per tool result, pairing back by toolUseId with
 *     toolResult / toolResultIsError;
 *   - ONE `usage` event per iteration: tokensIn = prompt_eval_count,
 *     tokensOut = eval_count, contextTokens = their sum, costUsd = 0 (local
 *     runs are free — a REAL 0, which accumulate() treats as authoritative);
 *   - `system` events for run-start/degrade notices, `error` for loop faults.
 *
 * The loop assigns seq via the supervisor's injected nextSeq() and pushes every
 * event through the shared validate→accumulate→emit onEvent seam (B3), so
 * these constructors stay pure value builders.
 */

import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { classifyTool } from '../providers.js'

type Base = { runId: string; seq: number }

export function systemEvent(base: Base, text: string): AgentEvent {
  return { id: uuid(), runId: base.runId, seq: base.seq, type: 'system', ts: Date.now(), text }
}

export function errorEvent(base: Base, text: string): AgentEvent {
  return { id: uuid(), runId: base.runId, seq: base.seq, type: 'error', ts: Date.now(), text }
}

/** The model's prose for one iteration (omitted by the loop when empty). */
export function assistantTextEvent(base: Base, text: string): AgentEvent {
  return { id: uuid(), runId: base.runId, seq: base.seq, type: 'assistant', ts: Date.now(), text }
}

/** One tool_use — mirrors parseClaudeLine's assistant/tool_use enrichment. */
export function assistantToolUseEvent(
  base: Base,
  opts: { tool: string; toolUseId: string; toolInput?: unknown; raw?: string },
): AgentEvent {
  return {
    id: uuid(),
    runId: base.runId,
    seq: base.seq,
    type: 'assistant',
    ts: Date.now(),
    tool: opts.tool,
    toolUseId: opts.toolUseId,
    toolKind: classifyTool(opts.tool),
    ...(opts.toolInput !== undefined ? { toolInput: opts.toolInput } : {}),
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
  }
}

/** One tool_result — mirrors parseClaudeLine's user/tool_result enrichment.
 *  `toolResult` carries the FULL (event-side) result text; the loop separately
 *  truncates what goes back to the model. */
export function userToolResultEvent(
  base: Base,
  opts: { toolUseId: string; toolResult: unknown; isError: boolean },
): AgentEvent {
  return {
    id: uuid(),
    runId: base.runId,
    seq: base.seq,
    type: 'user',
    ts: Date.now(),
    toolUseId: opts.toolUseId,
    toolResult: opts.toolResult,
    toolResultIsError: opts.isError,
  }
}

/** Per-iteration usage snapshot. costUsd is a REAL 0 (free local run): the
 *  supervisor's accumulate() takes `!= null` cost as authoritative last-wins,
 *  so the run row lands at $0 — never a stale carried-over figure.
 *
 *  NB `contextTokens` semantics deliberately DIVERGE from claude's: claude
 *  reports input-side context only (fresh + cache_creation + cache_read); here
 *  it is prompt_eval + eval — the tokens occupying the model's num_ctx window
 *  this turn, which is the meaningful pressure signal for a local model. Any
 *  future context-pressure UI must interpret the field per provider. */
export function usageEvent(
  base: Base,
  opts: { promptEvalCount?: number; evalCount?: number },
): AgentEvent {
  const tokensIn = opts.promptEvalCount ?? 0
  const tokensOut = opts.evalCount ?? 0
  const ctx = tokensIn + tokensOut
  return {
    id: uuid(),
    runId: base.runId,
    seq: base.seq,
    type: 'usage',
    ts: Date.now(),
    tokensIn,
    tokensOut,
    costUsd: 0,
    ...(ctx > 0 ? { contextTokens: ctx } : {}),
  }
}
