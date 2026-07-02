/**
 * mgmt stdio MCP server — the Chief's management working store exposed to a managed run.
 *
 * Thin transport glue over the authoritative store layer (./mgmt.ts): it registers
 * each mgmt tool on an MCP server and speaks JSON-RPC over stdio. All store logic,
 * validation, and the K_RUN_ID resolution live in mgmt.ts (which is SDK-free and
 * unit-tested); this file only wires them up.
 *
 * Launched as a child process by a managed run (the Chief) via `claude --mcp-config`.
 * The synthesizer injects K_DATA_DIR (so ../db.js opens the right k.db) and K_RUN_ID
 * (the current run) into this process's env. stdout is the JSON-RPC channel and MUST
 * stay clean — diagnostics go to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mgmtTools, MgmtError, type MgmtContext } from './mgmt.js'

const ctx: MgmtContext = { runId: process.env.K_RUN_ID ?? null }

const server = new McpServer({ name: 'mgmt', version: '0.0.1' })

for (const tool of mgmtTools) {
  server.registerTool(
    tool.name,
    // The store layer re-validates authoritatively; advertising the shape gives
    // the client a typed schema and a first-pass validation.
    { description: tool.description, inputSchema: tool.inputShape },
    async (args: unknown) => {
      try {
        const result = await tool.handler(args, ctx)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e) {
        // MgmtError messages are caller-facing by design. Anything else is an
        // internal fault: return a generic message (don't leak SQLite/schema
        // internals to the agent) and log the detail to stderr.
        if (!(e instanceof MgmtError)) {
          console.error(`[mgmt] ${tool.name} failed:`, e)
        }
        const msg = e instanceof MgmtError ? e.message : `mgmt: internal error in ${tool.name}.`
        return { content: [{ type: 'text' as const, text: msg }], isError: true }
      }
    },
  )
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((e: unknown) => {
  // stderr only — stdout carries MCP JSON-RPC.
  console.error('[mgmt] fatal:', e)
  process.exit(1)
})
