/**
 * Minimal stdio MCP server for the capability-probe tests (A4). Registers TWO
 * tools so the probe's tools/list sees a deterministic, non-trivial surface.
 * Named probe-mcp-server.mjs (Lane B ships its own fake-mcp-server.mjs — keep
 * the fixtures separate to avoid a merge collision).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'k-probe-fixture', version: '1.0.0' })

server.tool('echo', 'Echo the input text back.', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}))

server.tool('add', 'Add two numbers.', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}))

await server.connect(new StdioServerTransport())
