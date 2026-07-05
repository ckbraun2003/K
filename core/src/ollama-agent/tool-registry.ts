/**
 * Tool registry — the ONE dispatch table of an Ollama agent run (D-072).
 *
 * Maps every ADVERTISED (model-facing) tool name to its executor:
 *   - native tools (native-tools.ts) under their claude-compatible names;
 *   - MCP tools under mcp__<server>__<tool> (mangled names round-trip through
 *     THIS registry's Map — never string-parsed back).
 *
 * ALLOWLIST ENFORCEMENT IS DOUBLE (fail-closed both ways):
 *   1. advertise-time — an MCP tool enters the registry ONLY when the run's
 *      resolved allowedTools carries `mcp__<server>` (server-level) or the
 *      exact `mcp__<server>__<tool>` grant. The predicate is authority.ts::
 *      toolWithinCeiling — the SAME function the profile ceiling checks use,
 *      so grant semantics cannot drift. (Native tools were already gated at
 *      construction by createNativeTools.)
 *   2. dispatch-time — the loop rejects any name the registry doesn't hold, so
 *      a hallucinated/ungranted tool never executes (loop.ts).
 */

import { toolWithinCeiling } from '../authority.js'
import {
  advertisedMcpToolName,
  mcpContentToText,
  type McpClient,
  type McpToolDef,
} from '../mcp-client.js'
import type { NativeTool } from './native-tools.js'
import type { OllamaToolDef } from './transport.js'

export interface ToolDispatchResult {
  /** Result text — fed back to the model (truncated loop-side) and carried on
   *  the run's user event. */
  text: string
  isError: boolean
}

export interface RegisteredTool {
  /** The model-facing name (native name, or mangled mcp__<server>__<tool>). */
  advertised: string
  kind: 'native' | 'mcp'
  /** For an MCP tool: the server + ORIGINAL tool name (the Map round-trip). */
  origin?: { server: string; tool: string }
  description?: string
  parameters?: Record<string, unknown>
  dispatch(
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolDispatchResult>
}

export interface ToolRegistry {
  /** Stable advertising order: natives first, then MCP servers in mount order. */
  tools: RegisteredTool[]
  get(advertised: string): RegisteredTool | undefined
  /** The /api/chat `tools` array (OpenAI-style function defs). */
  toOllamaTools(): OllamaToolDef[]
  counts: { native: number; mcp: number }
}

export interface ConnectedMcpServer {
  client: McpClient
  /** tools/list result captured at run start (connections are reused). */
  tools: McpToolDef[]
}

/**
 * Build the registry from already-gated native tools + connected MCP servers.
 * Ungranted MCP tools are silently omitted (not advertised — gate 1). A name
 * collision (should be impossible: natives never start with mcp__, mangled
 * names are hash-distinct) keeps the FIRST registration and warns.
 */
export function buildToolRegistry(opts: {
  nativeTools: NativeTool[]
  mcpServers: ConnectedMcpServer[]
  allowedTools: string[]
}): ToolRegistry {
  const byName = new Map<string, RegisteredTool>()
  const ceiling = new Set(opts.allowedTools)
  let nativeCount = 0
  let mcpCount = 0

  for (const t of opts.nativeTools) {
    if (byName.has(t.name)) {
      console.warn(`[ollama-agent] duplicate native tool "${t.name}" — keeping the first`)
      continue
    }
    byName.set(t.name, {
      advertised: t.name,
      kind: 'native',
      description: t.description,
      parameters: t.inputSchema as unknown as Record<string, unknown>,
      dispatch: async (args, o) => t.execute(args, { signal: o.signal }),
    })
    nativeCount++
  }

  for (const server of opts.mcpServers) {
    const serverName = server.client.name
    for (const tool of server.tools) {
      // Gate 1: the run's allowlist must grant the server (mcp__<server>) or
      // the exact tool (mcp__<server>__<tool>) — toolWithinCeiling's mcp branch.
      if (!toolWithinCeiling(`mcp__${serverName}__${tool.name}`, ceiling)) continue
      const advertised = advertisedMcpToolName(serverName, tool.name)
      if (byName.has(advertised)) {
        console.warn(`[ollama-agent] duplicate advertised tool "${advertised}" — keeping the first`)
        continue
      }
      byName.set(advertised, {
        advertised,
        kind: 'mcp',
        origin: { server: serverName, tool: tool.name },
        description: tool.description,
        parameters: tool.inputSchema,
        dispatch: async (args, o) => {
          const res = await server.client.callTool(tool.name, args, {
            timeoutMs: o.timeoutMs,
            signal: o.signal,
          })
          return { text: mcpContentToText(res.content), isError: res.isError }
        },
      })
      mcpCount++
    }
  }

  const tools = [...byName.values()]
  return {
    tools,
    get: name => byName.get(name),
    toOllamaTools: () =>
      tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.advertised,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      })),
    counts: { native: nativeCount, mcp: mcpCount },
  }
}
