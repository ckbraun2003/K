#!/usr/bin/env node
// Fake stdio MCP server for ollama-mcp-client tests: newline-delimited JSON-RPC
// 2.0, no SDK dependency (proves the client against the raw wire protocol).
// Tools: echo (round trip), sleep (per-call timeout), crash (exit mid-call),
// fail (isError result), and an invalid-charset long name (mangling round trip).
import readline from 'node:readline'

// NB: duplicated in ollama-mcp-client.test.ts (never import this module — it
// grabs stdin at load). Keep the two literals in sync.
const WEIRD_TOOL_NAME =
  'weird.tool:name/with spaces and a very long suffix padding it well past the sixty-four character limit'

const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'sleep', description: 'Sleep ms then return', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'crash', description: 'Exit the process without responding', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Return an isError tool result', inputSchema: { type: 'object', properties: {} } },
  { name: WEIRD_TOOL_NAME, description: 'Tool whose name needs mangling', inputSchema: { type: 'object', properties: {} } },
]

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const result = (id, res) => send({ jsonrpc: '2.0', id, result: res })
const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.1' },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') return result(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') return result(id, { content: [{ type: 'text', text: String(args.text ?? '') }] })
    if (name === 'sleep') {
      const ms = Number(args.ms ?? 0)
      return void setTimeout(() => result(id, { content: [{ type: 'text', text: `slept ${ms}` }] }), ms)
    }
    if (name === 'crash') return process.exit(1)
    if (name === 'fail') return result(id, { content: [{ type: 'text', text: 'deliberate failure' }], isError: true })
    if (name === WEIRD_TOOL_NAME) return result(id, { content: [{ type: 'text', text: 'weird ok' }] })
    return rpcError(id, -32602, `unknown tool ${String(name)}`)
  }
  if (id !== undefined) rpcError(id, -32601, `unknown method ${String(method)}`)
})
