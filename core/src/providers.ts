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
import { buildClaudeArgs, type PermissionMode, type ClaudeConfigArgs } from './claude-args.js'

export type ParseCtx = { tokensIn: number; tokensOut: number; costUsd: number }

/** `model` is the routed/selected model name — for claude it is forwarded as
 *  `--model <id>` when set (see buildClaudeArgs); for ollama it is the
 *  `ollama run <model>` target. `claudeConfig` carries the per-run K-owned
 *  isolation config for managed claude runs; ollama ignores it. */
export type BuildArgsOptions = { inWorktree: boolean; permissionMode: PermissionMode; model?: string; interactive?: boolean; claudeConfig?: ClaudeConfigArgs }

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

/** Pure, table-driven mapper from a tool name to its rendering kind.
 *  `Bash` → command; the edit family → file; `Task`/`Agent` (this environment
 *  names the delegation tool `Agent`) → delegate; anything else → other. */
const TOOL_KIND: Record<string, 'command' | 'file' | 'delegate'> = {
  Bash: 'command',
  Write: 'file',
  Edit: 'file',
  MultiEdit: 'file',
  NotebookEdit: 'file',
  Task: 'delegate',
  Agent: 'delegate',
}

export function classifyTool(name: string): 'command' | 'file' | 'delegate' | 'other' {
  // Prototype-safe lookup: a tool name that collides with an inherited
  // Object.prototype member (`toString`, `constructor`, …) must NOT resolve to
  // that member — only own keys count, everything else is 'other'.
  return Object.hasOwn(TOOL_KIND, name) ? TOOL_KIND[name] : 'other'
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
        // The captured stream emits one tool_use per assistant line in practice;
        // if a line ever batches multiple tool_use blocks we enrich the FIRST one
        // (one-event-per-line, seq model unchanged) — `raw` retains the rest.
        // NB: this flips the legacy `event.tool` from last-wins to first-wins on a
        // multi-tool_use line (the prior loop overwrote it down to the last block).
        let toolUseSeen = false
        for (const block of content) {
          if (block.type === 'text') event.text = String(block.text ?? '')
          if (block.type === 'tool_use' && !toolUseSeen) {
            toolUseSeen = true
            const name = String(block.name ?? '')
            const input = (block.input as Record<string, unknown> | undefined) ?? undefined
            event.tool = name
            event.toolUseId = typeof block.id === 'string' ? block.id : undefined
            event.toolKind = classifyTool(name)
            if (input !== undefined) event.toolInput = input
            if (event.toolKind === 'delegate' && input) {
              // subagent_type is OPTIONAL (absent → default agent).
              if (typeof input.subagent_type === 'string') event.subagentType = input.subagent_type
              // Human label: description, else the first ~60 chars of the prompt.
              if (typeof input.description === 'string' && input.description.length > 0) {
                event.childLabel = input.description
              } else if (typeof input.prompt === 'string') {
                event.childLabel = input.prompt.slice(0, 60)
              }
            }
          }
        }
      }
      // Usage from message. `tokensIn` stays FRESH input only (cost/metrics
      // accounting unchanged); `contextTokens` is the full input context size
      // for this turn (fresh + cache_creation + cache_read) for the indicator.
      const usage = msg.usage as Record<string, number> | undefined
      if (usage) {
        if (usage.input_tokens != null) event.tokensIn = usage.input_tokens
        if (usage.output_tokens != null) event.tokensOut = usage.output_tokens
        const ctx = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        if (ctx > 0) event.contextTokens = ctx
      }
    }

    // User turn: a tool_result block pairs back to its tool_use by tool_use_id.
    // content may be an ARRAY of blocks; tool_result `content` is preserved as-is
    // (string for Bash/Write, array of {type,text} for Agent). Leave event.text
    // undefined — the structured fields carry the result.
    if (type === 'user' && obj.message) {
      const msg = obj.message as Record<string, unknown>
      const content = msg.content
      if (Array.isArray(content)) {
        const block = (content as Array<Record<string, unknown>>).find(b => b.type === 'tool_result')
        if (block) {
          if (typeof block.tool_use_id === 'string') event.toolUseId = block.tool_use_id
          if (block.content !== undefined) event.toolResult = block.content
          // is_error is often absent → leave undefined; only set when present.
          if (block.is_error === true || block.is_error === false) event.toolResultIsError = block.is_error
        }
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
      // The full input sum is also the turn's context size — carry it on the
      // final 'usage' event so the indicator reflects the end-of-run context.
      if (tokensIn > 0) event.contextTokens = tokensIn
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
