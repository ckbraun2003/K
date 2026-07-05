/**
 * The Ollama agent loop (D-072) — K's OWN tool-calling engine over /api/chat,
 * giving local models full parity with managed claude runs: the same resolved
 * assets (run-assets.ts), the same skills (index + read_skill), the same MCP
 * servers (mcp-client.ts), the same event shapes (events.ts).
 *
 * PURE ORCHESTRATION: no fetch, no spawn, no DB. All I/O flows through the
 * injected deps — `transport` (OllamaChatTransport) and `connectMcp` — which is
 * the test seam: loop tests script a fake transport + fake MCP clients and
 * assert the emitted event stream.
 *
 * OWNERSHIP: the supervisor stays the owner of the run lifecycle. It calls
 * startOllamaAgentRun(...) → { kill, done }, registers `kill` in
 * activeProcesses, awaits `done`, and falls through to the SAME terminal-status
 * code as the claude path (B3). `kill` is AbortController.abort() — idempotent,
 * tolerant of signal-name args (SIGTERM/SIGKILL escalation calls it twice).
 * `done` NEVER rejects: any loop fault becomes an `error` event + exitCode 1.
 *
 * Iteration protocol (per D-072):
 *   stream chat (messages + tools) → buffer content, collect tool_calls from
 *   ANY chunk (protocol drift) → emit ONE assistant text event + ONE assistant
 *   event per tool_call + ONE usage event → no tool_calls → exit 0. Each
 *   tool_call: registry check (unknown/ungranted/malformed-args are NOT
 *   executed — an error result is fed back so the model self-corrects) →
 *   dispatch → user event + role:'tool' message (truncated to 8k chars).
 *   Limits: maxIterations 25, runTimeoutMs 10min, toolCallTimeoutMs 60s (MCP
 *   calls; native tools self-limit — Bash carries its own 120s default), and a
 *   repeated-identical-call detector (same tool+args 3× consecutive → a
 *   warning message is injected so the model breaks the loop).
 */

import type { AgentEvent } from '@k/shared'
import type { AgentProfile } from '../profiles.js'
import { resolveRunAssets, type ResolvedRunAssets } from '../run-assets.js'
import { connectStdioMcp } from '../mcp-client.js'
import {
  createNativeTools,
  buildSkillIndex,
  buildInlineSkillsSection,
  truncateOutput,
  type FsScope,
} from './native-tools.js'
import {
  resolveModelCapability,
  markModelToolUnsupported,
  isToolUnsupportedError,
} from './capability.js'
import { buildToolRegistry, type ConnectedMcpServer, type ToolRegistry } from './tool-registry.js'
import type { OllamaChatMessage, OllamaChatTransport, OllamaToolCall } from './transport.js'
import {
  assistantTextEvent,
  assistantToolUseEvent,
  errorEvent,
  systemEvent,
  usageEvent,
  userToolResultEvent,
} from './events.js'
import { v4 as uuid } from 'uuid'

export const DEFAULT_NUM_CTX = 16_384
export const DEFAULT_MAX_ITERATIONS = 25
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
/** Cap on the tool-result text fed back to the MODEL (the run event carries up
 *  to the tool's own output cap — the console sees more than the model). */
export const TOOL_RESULT_MESSAGE_CAP_CHARS = 8_000
/** Identical (tool, args) calls tolerated before the loop injects a warning. */
export const REPEAT_CALL_LIMIT = 3
/** Context-pressure warning threshold: prompt_eval_count vs the model's shown
 *  context length (B4). */
export const CONTEXT_PRESSURE_RATIO = 0.85

export interface OllamaAgentRunConfig {
  runId: string
  model: string
  prompt: string
  /** The run's working dir (worktree) — native-tool guard root + Bash cwd. */
  cwd: string
  /** Resolved via resolveRunAssets(profile) unless `assets` is injected. */
  profile?: AgentProfile
  assets?: ResolvedRunAssets
  suppressGitnexus?: boolean
  /** Supervisor-owned per-run seq counter. */
  nextSeq: () => number
  /** The shared validate→accumulate→emit seam (B3). Called for EVERY event. */
  onEvent: (event: AgentEvent) => void
  numCtx?: number
  /** Capability-policy PIN (tests / callers that already probed). Absent →
   *  the loop resolves it via the capability policy (/api/show probe with a
   *  process-lifetime cache — capability.ts). false → tools are not
   *  advertised and the run degrades to prompt-only IN PLACE (never a silent
   *  claude fallback). */
  toolSupport?: boolean
  /** Model context window override; absent → taken from the capability probe.
   *  Feeds the context-pressure warning. */
  contextLength?: number
  maxIterations?: number
  runTimeoutMs?: number
  toolCallTimeoutMs?: number
  /** Native-tool fs scope override (default resolves K_OLLAMA_FS_SCOPE). */
  fsScope?: FsScope
}

export interface OllamaAgentDeps {
  transport: OllamaChatTransport
  /** Injectable MCP connector (default: the real stdio client). */
  connectMcp?: typeof connectStdioMcp
  /** Injectable native-tool factory (default: the real fs/execa tools). */
  createTools?: typeof createNativeTools
}

export interface OllamaAgentHandle {
  /** AbortController.abort() — idempotent; tolerates signal-name args. */
  kill: (...args: unknown[]) => void
  /** Resolves when the run is fully torn down (MCP closed). Never rejects. */
  done: Promise<{ exitCode: number }>
}

/** The Ollama-specific system-prompt appendix: environment + tool rules +
 *  the one-line-per-skill index (full bodies load via read_skill). */
export function buildSystemPrompt(
  assets: ResolvedRunAssets,
  opts: { cwd: string; toolSupport: boolean },
): string {
  const parts: string[] = [assets.systemPrompt]
  parts.push(
    [
      '## Environment (K ollama agent run)',
      `- Working directory: ${opts.cwd} (a disposable git worktree — commit as needed, NEVER push).`,
      '- You are a local model driven by K\'s tool loop.',
    ].join('\n'),
  )
  if (opts.toolSupport) {
    parts.push(
      [
        '## Tool use',
        '- Use the provided tools to inspect and change files — never fabricate file contents or command output.',
        '- Tool arguments must be a valid JSON object matching the tool schema.',
        '- When the task is complete, reply with your final answer WITHOUT calling any tool.',
      ].join('\n'),
    )
    const index = buildSkillIndex(assets.skills)
    if (index.length > 0) {
      parts.push(
        [
          '## Skill index',
          'Mounted skills — load a body with read_skill(name) BEFORE applying it:',
          ...index.map(e => `- ${e.key}${e.description ? ` — ${e.description}` : ''}`),
        ].join('\n'),
      )
    }
  } else {
    // Degrade path (B4): no tools → no read_skill, so skill bodies are inlined
    // within the char budget (largest skipped with a note).
    const inline = buildInlineSkillsSection(assets.skills)
    if (inline) parts.push(inline)
  }
  return parts.join('\n\n---\n\n')
}

/** Parse a tool_call's arguments defensively: object → as-is; JSON string →
 *  parsed (must be an object); anything else / bad JSON → null (malformed). */
export function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* fall through */
    }
  }
  return null
}

export function startOllamaAgentRun(cfg: OllamaAgentRunConfig, deps: OllamaAgentDeps): OllamaAgentHandle {
  const controller = new AbortController()
  const signal = controller.signal
  let timedOut = false

  const kill = (..._args: unknown[]): void => {
    controller.abort()
  }

  const emit = (build: (base: { runId: string; seq: number }) => AgentEvent): void => {
    cfg.onEvent(build({ runId: cfg.runId, seq: cfg.nextSeq() }))
  }

  const isAbortError = (err: unknown): boolean =>
    err instanceof Error && err.name === 'AbortError'

  const done = (async (): Promise<{ exitCode: number }> => {
    const maxIterations = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS
    const runTimeoutMs = cfg.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    const toolCallTimeoutMs = cfg.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, runTimeoutMs)

    const mcpClients: ConnectedMcpServer[] = []
    const closeAll = async (): Promise<void> => {
      await Promise.allSettled(mcpClients.map(s => s.client.close()))
    }

    try {
      // ── resolve assets (validate-before-anything; GrantError → error event) ──
      let assets = cfg.assets
      if (!assets) {
        if (!cfg.profile) throw new Error('ollama-agent: neither assets nor profile provided')
        assets = resolveRunAssets(cfg.profile, {
          runId: cfg.runId,
          suppressGitnexus: cfg.suppressGitnexus,
        })
      }

      // ── capability policy (B4): a pinned cfg.toolSupport wins (tests /
      //    pre-probed callers); otherwise resolve via /api/show with the
      //    process-lifetime cache. A tool-less model degrades IN PLACE —
      //    never a silent claude fallback. ──
      let toolSupport: boolean
      let contextLength = cfg.contextLength
      if (cfg.toolSupport != null) {
        toolSupport = cfg.toolSupport
      } else {
        const cap = await resolveModelCapability(cfg.model, deps.transport)
        toolSupport = cap.toolSupport
        contextLength = contextLength ?? cap.contextLength
      }

      // ── spawn ALL resolved MCP servers up front; a failure degrades, never
      //    kills the run (system event + continue). Connections are reused
      //    across iterations and closed in the finally below. ──
      const connectMcp = deps.connectMcp ?? connectStdioMcp
      if (toolSupport) {
        for (const server of assets.mcpServers) {
          // A kill landing mid-spawn must be honored promptly: the signal is
          // threaded into connect + tools/list (both abortable SDK requests),
          // checked between servers, and an abort-time failure emits no
          // misleading "failed to start" noise — the run is simply ending.
          if (signal.aborted) break
          try {
            const client = await connectMcp(server.name, server.config, { signal })
            try {
              const tools = await client.listTools({ signal })
              mcpClients.push({ client, tools })
            } catch (err) {
              await client.close()
              if (!signal.aborted) {
                emit(b => systemEvent(b,
                  `MCP server ${server.name} failed to list tools — tools unavailable (${(err as Error).message})`))
              }
            }
          } catch (err) {
            if (!signal.aborted) {
              emit(b => systemEvent(b,
                `MCP server ${server.name} failed to start — tools unavailable (${(err as Error).message})`))
            }
          }
        }
        if (signal.aborted) return { exitCode: 1 }
      }

      const createTools = deps.createTools ?? createNativeTools
      const nativeTools = toolSupport
        ? createTools(assets.allowedTools, {
            worktree: cfg.cwd,
            skills: assets.skills,
            ...(cfg.fsScope ? { fsScope: cfg.fsScope } : {}),
          })
        : []
      const registry: ToolRegistry = buildToolRegistry({
        nativeTools,
        mcpServers: mcpClients,
        allowedTools: assets.allowedTools,
      })

      // Run-start system event — the truthful runtime declaration the console
      // badge derives from (B4). Keep the format stable.
      emit(b => systemEvent(b,
        `ollama-agent: model=${cfg.model}, tools=${registry.tools.length} (native ${registry.counts.native}, mcp ${registry.counts.mcp}), skills=${assets.skills.length}, toolSupport=${toolSupport}`))

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(assets, { cwd: cfg.cwd, toolSupport }) },
        { role: 'user', content: cfg.prompt },
      ]

      let lastCallSig: string | null = null
      let repeatCount = 0
      let contextPressureWarned = false

      for (let iter = 0; iter < maxIterations; iter++) {
        if (signal.aborted) return { exitCode: 1 }

        // ── one /api/chat stream: buffer text, collect tool_calls from ANY
        //    chunk, capture the final chunk's usage counters ──
        let text = ''
        const toolCalls: OllamaToolCall[] = []
        let promptEvalCount: number | undefined
        let evalCount: number | undefined
        try {
          for await (const chunk of deps.transport.chat(
            {
              model: cfg.model,
              messages,
              ...(toolSupport && registry.tools.length > 0 ? { tools: registry.toOllamaTools() } : {}),
              options: { num_ctx: cfg.numCtx ?? DEFAULT_NUM_CTX },
            },
            signal,
          )) {
            if (typeof chunk.message?.content === 'string') text += chunk.message.content
            if (Array.isArray(chunk.message?.tool_calls)) toolCalls.push(...chunk.message.tool_calls)
            if (typeof chunk.prompt_eval_count === 'number') promptEvalCount = chunk.prompt_eval_count
            if (typeof chunk.eval_count === 'number') evalCount = chunk.eval_count
          }
        } catch (err) {
          // B4 try-once fallback: an old daemon (no capabilities field) was
          // attempted WITH tools and rejected 400 — degrade IN PLACE to
          // prompt-only (skills inlined), cache the verdict for later runs of
          // this model, and retry the turn. Never a silent claude fallback.
          if (toolSupport && isToolUnsupportedError(err)) {
            toolSupport = false
            markModelToolUnsupported(cfg.model)
            messages[0] = {
              role: 'system',
              content: buildSystemPrompt(assets, { cwd: cfg.cwd, toolSupport: false }),
            }
            emit(b => systemEvent(b,
              `ollama-agent: model=${cfg.model} rejected tools (400) — degraded to prompt-only, skills inlined`))
            continue
          }
          throw err
        }

        // ── context-pressure warning (B4): the prompt already occupies >85% of
        //    the model's shown context window — warn ONCE per run. ──
        if (
          !contextPressureWarned &&
          contextLength != null &&
          promptEvalCount != null &&
          promptEvalCount > CONTEXT_PRESSURE_RATIO * contextLength
        ) {
          contextPressureWarned = true
          emit(b => systemEvent(b,
            `ollama-agent: context pressure — prompt_eval_count ${promptEvalCount} exceeds 85% of the model context (${contextLength}); raise num_ctx or shorten the task`))
        }

        // ── events for this iteration (shapes pairToolCalls understands) ──
        if (text.length > 0) emit(b => assistantTextEvent(b, text))
        // Args are parsed ONCE here and used for both the event's toolInput and
        // the dispatch — a daemon that stringifies arguments (protocol drift)
        // still renders real tool cards in the console. null = malformed (the
        // raw value is kept on the event for debuggability, and the dispatch
        // below rejects without executing). Duplicate ids across chunks are
        // dropped (a cumulative-array daemon would otherwise double-execute).
        const seenCallIds = new Set<string>()
        const callsWithIds: Array<{
          call: OllamaToolCall
          toolUseId: string
          name: string
          args: Record<string, unknown> | null
        }> = []
        for (const call of toolCalls) {
          const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : null
          if (id !== null) {
            if (seenCallIds.has(id)) continue
            seenCallIds.add(id)
          }
          callsWithIds.push({
            call,
            toolUseId: id ?? uuid(),
            name: typeof call.function?.name === 'string' ? call.function.name : '',
            args: parseToolArgs(call.function?.arguments),
          })
        }
        for (const c of callsWithIds) {
          emit(b => assistantToolUseEvent(b, {
            tool: c.name || '(unnamed tool)',
            toolUseId: c.toolUseId,
            toolInput: c.args ?? c.call.function?.arguments,
            raw: safeStringify(c.call),
          }))
        }
        emit(b => usageEvent(b, { promptEvalCount, evalCount }))

        // ── no tool calls → the model is done → exit 0 ──
        if (callsWithIds.length === 0) return { exitCode: 0 }

        // History: the assistant message (with its tool_calls) precedes results.
        messages.push({ role: 'assistant', content: text, tool_calls: toolCalls })

        // ── repeated-identical-call detector ──
        // Signature covers the whole call SET, so a model stuck re-issuing the
        // same parallel pair (or triple, ...) trips the detector too.
        const sig = safeStringify(callsWithIds.map(c => [c.name, c.call.function?.arguments ?? null]))
        if (sig === lastCallSig) repeatCount++
        else repeatCount = 1
        lastCallSig = sig

        // ── dispatch each call sequentially ──
        for (const c of callsWithIds) {
          if (signal.aborted) return { exitCode: 1 }
          const args = c.args // parsed once, shared with the event's toolInput
          // toolSupport re-gates dispatch too: after a mid-run degrade the
          // registry still exists, but a straggler/hallucinated tool_call must
          // be rejected like any ungranted tool — the run declared prompt-only.
          const registered = toolSupport && c.name ? registry.get(c.name) : undefined

          let result: { text: string; isError: boolean }
          if (args === null) {
            // Malformed arguments: NOT executed — the error feeds back.
            result = {
              text: `Tool call rejected: arguments for "${c.name}" are not a valid JSON object.`,
              isError: true,
            }
          } else if (!registered) {
            // Unknown OR ungranted (never advertised): NOT executed.
            const available = registry.tools.map(t => t.advertised).join(', ') || '(none)'
            result = {
              text: `Tool "${c.name}" is not available in this run. Available tools: ${available}`,
              isError: true,
            }
          } else {
            try {
              result = await registered.dispatch(args, { signal, timeoutMs: toolCallTimeoutMs })
            } catch (err) {
              if (signal.aborted) return { exitCode: 1 }
              result = { text: `Tool call failed: ${(err as Error).message}`, isError: true }
            }
          }

          emit(b => userToolResultEvent(b, {
            toolUseId: c.toolUseId,
            toolResult: result.text,
            isError: result.isError,
          }))
          messages.push({
            role: 'tool',
            content: truncateOutput(result.text, TOOL_RESULT_MESSAGE_CAP_CHARS),
            tool_name: c.name || undefined,
          })
        }

        if (repeatCount >= REPEAT_CALL_LIMIT) {
          const names = [...new Set(callsWithIds.map(c => c.name))].join(', ')
          messages.push({
            role: 'user',
            content:
              `You have called ${names} with identical arguments ${repeatCount} times in a row. ` +
              'Do not repeat the same call — use the results you already have, try different arguments, or finish with your answer.',
          })
          repeatCount = 0
          lastCallSig = null
        }
      }

      // Iteration cap reached with the model still calling tools.
      emit(b => systemEvent(b, `ollama-agent: iteration cap (${maxIterations}) reached — stopping`))
      return { exitCode: 1 }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        // Run timeout is OUR abort — report it. An operator kill stays silent
        // here; the supervisor's killedRuns bookkeeping owns the 'killed' status.
        if (timedOut) {
          emit(b => errorEvent(b, `ollama-agent: run timed out after ${runTimeoutMs}ms`))
        }
        return { exitCode: 1 }
      }
      emit(b => errorEvent(b, String(err)))
      return { exitCode: 1 }
    } finally {
      clearTimeout(timer)
      await closeAll()
    }
  })()

  return { kill, done }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}
