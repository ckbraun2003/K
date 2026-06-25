/**
 * Provider seam — the dispatch half of the ModelRouter B-seam.
 *
 * `route()` (router.ts) decides WHICH provider; this module decides HOW that
 * provider is dispatched: which binary to spawn, what argv to build, and how to
 * parse each output line into an AgentEvent. The supervisor dispatches on the
 * routed provider's name (and uses that provider's `parseLine`), so choosing
 * "ollama" can never silently run or be parsed as claude.
 *
 * `claudeProvider` wraps the Claude Code CLI (stream-json). `ollamaProvider`
 * wraps `ollama run <model>` for local models; its output is plain text streamed
 * line by line (local runs are free, so cost/tokens stay 0). Routing only ever
 * selects ollama when it is enabled AND reachable (see router.ts), so the
 * supervisor never has to special-case an absent binary.
 */

import { v4 as uuid } from 'uuid'
import type { AgentEvent } from '@k/shared'
import { buildClaudeArgs, type PermissionMode } from './claude-args.js'

export type ParseCtx = { tokensIn: number; tokensOut: number; costUsd: number }

/** `model` is the routed/selected model name — for claude it is forwarded as
 *  `--model <id>` when set (see buildClaudeArgs); for ollama it is the
 *  `ollama run <model>` target. */
export type BuildArgsOptions = { inWorktree: boolean; permissionMode: PermissionMode; model?: string }

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

// ── ollama ────────────────────────────────────────────────────────────────────

const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2'

/** Build argv for `ollama run <model> <prompt>` — a one-shot headless completion
 *  that streams the response to stdout. Permission mode / worktree gating do not
 *  apply to a local model, so those opts are intentionally ignored. */
export function buildOllamaArgs(prompt: string, opts: BuildArgsOptions): string[] {
  return ['run', opts.model ?? OLLAMA_FALLBACK_MODEL, prompt]
}

/** Parse one line of `ollama run` output into an assistant AgentEvent.
 *  The CLI streams plain text; we also tolerate NDJSON (`{response, done}`) in
 *  case a future invocation uses `--format json`. Local runs are free, so no
 *  token/cost fields are emitted (they default to 0 via the supervisor). */
export function parseOllamaLine(
  line: string,
  runId: string,
  seq: number,
  _ctx: ParseCtx,
): AgentEvent | null {
  let text = line
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    if (obj && typeof obj.response === 'string') text = obj.response
  } catch {
    // plain-text line — use as-is
  }
  if (!text) return null
  return { id: uuid(), runId, seq, type: 'assistant', ts: Date.now(), text, raw: line }
}

export const ollamaProvider: Provider = {
  name: 'ollama',
  binary: 'ollama',
  buildArgs: buildOllamaArgs,
  parseLine: parseOllamaLine,
}

/** Resolve a Provider implementation from a routed provider name. */
export function getProvider(name: 'claude' | 'ollama'): Provider {
  return name === 'ollama' ? ollamaProvider : claudeProvider
}
