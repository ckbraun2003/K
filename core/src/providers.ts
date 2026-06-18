/**
 * Provider seam — the honest half of the Architecture-C router.
 *
 * `route()` (router.ts) decides WHICH provider; this module decides HOW that
 * provider is dispatched: which binary to spawn, what argv to build, and how to
 * parse each NDJSON output line into an AgentEvent. The supervisor dispatches on
 * the routed provider's name so choosing "ollama" can never silently run claude.
 *
 * Phase 0: only `claudeProvider` is implemented. `ollamaProvider` is a stub that
 * throws on dispatch — adding a real Ollama integration later is a contained
 * change (implement buildArgs/parseLine here, no supervisor edits).
 */

import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { buildClaudeArgs, type PermissionMode } from './claude-args.js'

export type ParseCtx = { tokensIn: number; tokensOut: number; costUsd: number }

export type BuildArgsOptions = { inWorktree: boolean; permissionMode: PermissionMode }

export interface Provider {
  /** Routed provider name — matches RouteResult.provider. */
  readonly name: 'claude' | 'ollama'
  /** CLI binary spawned by the supervisor. */
  readonly binary: string
  /** Build the argv for a headless run. */
  buildArgs(prompt: string, opts: BuildArgsOptions): string[]
  /** Parse one NDJSON output line into an AgentEvent (null = ignore). */
  parseLine(line: string, runId: string, seq: number, ctx: ParseCtx): AgentEvent | null
}

// ── claude ────────────────────────────────────────────────────────────────────

function mapType(raw: string): AgentEvent['type'] {
  if (raw === 'system') return 'system'
  if (raw === 'assistant') return 'assistant'
  if (raw === 'user') return 'user'
  if (raw === 'result') return 'usage'
  return 'assistant'
}

/** Parse one line of `claude --output-format stream-json` output. */
export function parseClaudeLine(
  line: string,
  runId: string,
  seq: number,
  _ctx: ParseCtx,
): AgentEvent | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    const type = (obj.type as string) ?? 'assistant'

    const event: AgentEvent = {
      id: uuid(),
      runId,
      seq,
      type: mapType(type),
      ts: Date.now(),
      raw: line,
    }

    // Extract display text
    if (type === 'assistant' && obj.message) {
      const msg = obj.message as Record<string, unknown>
      const content = msg.content as Array<Record<string, unknown>> | undefined
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') event.text = String(block.text ?? '')
          if (block.type === 'tool_use') event.tool = String(block.name ?? '')
        }
      }
      // Usage from message
      const usage = msg.usage as Record<string, number> | undefined
      if (usage) {
        if (usage.input_tokens != null) event.tokensIn = usage.input_tokens
        if (usage.output_tokens != null) event.tokensOut = usage.output_tokens
      }
    }

    if (type === 'result') {
      const stats = obj as Record<string, unknown>
      // Current CLI nests usage and reports total_cost_usd; keep the old
      // top-level fields as fallbacks for older CLI versions
      const usage = stats.usage as Record<string, number> | undefined
      const tokensIn = usage
        ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        : typeof stats.input_tokens === 'number' ? stats.input_tokens : 0
      const tokensOut = usage?.output_tokens ?? (typeof stats.output_tokens === 'number' ? stats.output_tokens : 0)
      if (tokensIn != null) event.tokensIn = tokensIn
      if (tokensOut != null) event.tokensOut = tokensOut
      const cost = typeof stats.total_cost_usd === 'number' ? stats.total_cost_usd
        : typeof stats.cost_usd === 'number' ? stats.cost_usd : 0
      if (cost != null) event.costUsd = cost
      event.text = typeof stats.result === 'string' ? stats.result : undefined
    }

    return event
  } catch {
    // Tolerant: ignore malformed lines
    return null
  }
}

export const claudeProvider: Provider = {
  name: 'claude',
  binary: 'claude',
  buildArgs: buildClaudeArgs,
  parseLine: parseClaudeLine,
}

// ── ollama (stub) ───────────────────────────────────────────────────────────

const OLLAMA_NOT_IMPLEMENTED = 'ollama provider not yet implemented (Phase 3)'

/**
 * Stub: routing can pick ollama, but dispatching it must fail loudly rather than
 * silently falling back to claude. Implementing this later (buildArgs/parseLine)
 * is the whole change — no supervisor edits required.
 */
export const ollamaProvider: Provider = {
  name: 'ollama',
  binary: 'ollama',
  buildArgs() {
    throw new Error(OLLAMA_NOT_IMPLEMENTED)
  },
  parseLine() {
    throw new Error(OLLAMA_NOT_IMPLEMENTED)
  },
}

/** Resolve a Provider implementation from a routed provider name. */
export function getProvider(name: 'claude' | 'ollama'): Provider {
  return name === 'ollama' ? ollamaProvider : claudeProvider
}
