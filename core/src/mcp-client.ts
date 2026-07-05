/**
 * McpClient — K's thin stdio MCP CLIENT wrapper (host-integration Lane B, D-072).
 *
 * The Ollama agent runtime needs to CALL the same MCP servers a managed claude
 * run mounts (kstore / logistics / mgmt / gitnexus / discovered servers). This
 * module wraps @modelcontextprotocol/sdk's Client + StdioClientTransport
 * (already a core dependency — K's own MCP servers are built on the same SDK)
 * behind a minimal interface the tool loop consumes:
 *
 *   connectStdioMcp(name, cfg) → McpClient { listTools, callTool, close, pid }
 *
 * Lifecycle contract (loop.ts owns it): ALL resolved servers are spawned at run
 * start, connections are REUSED across loop iterations, and close() is called
 * for every client in the loop's `finally` (completion / error / kill /
 * timeout). A server that fails to spawn or initialize is DEGRADED, not fatal —
 * the caller catches the connect rejection, emits a system event, and runs on
 * without that server's tools.
 *
 * Tool naming (D-072): MCP tools are advertised to the model as
 * `mcp__<server>__<tool>` — the claude convention — so tier allowlists
 * (authority.ts predicates) and console rendering apply verbatim. The
 * round-trip back to {server, tool} is ALWAYS via the registry's Map, never by
 * string-parsing the advertised name: a name that exceeds 64 chars or carries
 * chars outside [A-Za-z0-9_-] is sanitized and suffixed with a 6-char content
 * hash (deterministic, collision-resistant), which is only reversible through
 * the Map. `advertisedMcpToolName` is the ONE mangling function (pure, exported
 * for tests + tool-registry.ts).
 */

import { createHash } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

/** The exact server-config shape run-assets.ts resolves (ResolvedMcpServer.config). */
export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/** One tool as reported by the server's tools/list. */
export interface McpToolDef {
  name: string
  description?: string
  /** JSON schema for the tool's arguments (advertised to the model verbatim). */
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  /** The MCP result content blocks, as-is (array of {type,text,…} in practice). */
  content: unknown
  isError: boolean
}

export interface McpClient {
  readonly name: string
  listTools(opts?: { timeoutMs?: number }): Promise<McpToolDef[]>
  callTool(
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<McpCallResult>
  /** Close the connection and kill the child. Safe to call more than once. */
  close(): Promise<void>
  /** The child process pid (null once gone / never spawned). */
  pid(): number | null
}

/** Default per-call timeout (D-072: per-tool 60s) — callers may override per call. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000
/** Default connect/initialize timeout (matches the D-070 probe's 15s hard cap). */
export const DEFAULT_MCP_INIT_TIMEOUT_MS = 15_000

/**
 * Spawn + initialize one stdio MCP server. Rejects on spawn failure, a failed
 * initialize handshake, or the init timeout — the caller treats a rejection as
 * "server degraded" (system event + continue), never fatal.
 *
 * Env semantics mirror how the claude CLI launches config-dir servers: the
 * child gets a minimal safe default environment PLUS the server config's own
 * env verbatim (run-assets has already injected K_DATA_DIR / K_RUN_ID for the
 * run-scoped K servers). The parent's full env — including any auth secrets —
 * is deliberately NOT inherited.
 */
export async function connectStdioMcp(
  name: string,
  cfg: McpServerConfig,
  opts: { initTimeoutMs?: number } = {},
): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...getDefaultEnvironment(), ...cfg.env },
    // A chatty server's stderr must not interleave with core's own logs; a
    // failed server is reported via the loop's degraded-server system event.
    stderr: 'ignore',
  })
  const client = new Client({ name: 'k-ollama-agent', version: '0.0.1' }, { capabilities: {} })
  try {
    await client.connect(transport, { timeout: opts.initTimeoutMs ?? DEFAULT_MCP_INIT_TIMEOUT_MS })
  } catch (err) {
    // Ensure a half-spawned child never outlives a failed handshake.
    try { await transport.close() } catch { /* already closed */ }
    throw err
  }

  let closed = false
  return {
    name,
    async listTools(o = {}) {
      const res = await client.listTools(undefined, {
        timeout: o.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
      })
      return res.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }))
    },
    async callTool(tool, args, o = {}) {
      const res = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: o.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
        signal: o.signal,
      })
      return { content: res.content, isError: res.isError === true }
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await client.close()
      } catch {
        /* transport already gone (crashed child) — close is best-effort */
      }
    },
    pid() {
      return transport.pid
    },
  }
}

// ─── tool-name mangling (pure) ───────────────────────────────────────────────

/** The charset+length envelope a tool name must fit for the chat API. */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const HASH_SUFFIX_LEN = 6

/**
 * The advertised (model-facing) name for an MCP tool: `mcp__<server>__<tool>`,
 * claude-convention. When that raw name is invalid (>64 chars or chars outside
 * [A-Za-z0-9_-]) it is sanitized + truncated and suffixed with `_<6-char sha256
 * of the raw name>` so distinct raw names stay distinct. Deterministic and
 * PURE — reversing an advertised name back to {server, tool} is the registry
 * Map's job, never string parsing.
 */
export function advertisedMcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  if (TOOL_NAME_RE.test(raw)) return raw
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, HASH_SUFFIX_LEN)
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  const trimmed = sanitized.slice(0, 64 - HASH_SUFFIX_LEN - 1)
  return `${trimmed}_${hash}`
}

/**
 * Flatten an MCP tool result's content blocks to the text fed back to the model
 * as the tool message. Text blocks pass through; any other block type is JSON-
 * stringified so structured results survive legibly. Tolerant of every shape —
 * never throws.
 */
export function mcpContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  return content
    .map(block => {
      const b = block as Record<string, unknown> | null
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text
      try { return JSON.stringify(block) } catch { return String(block) }
    })
    .join('\n')
}
