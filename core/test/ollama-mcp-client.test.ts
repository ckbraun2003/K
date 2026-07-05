/**
 * mcp-client.ts against the REAL wire protocol (Lane B, wave B1).
 *
 * Spawns test/fixtures/fake-mcp-server.mjs — a raw newline-delimited JSON-RPC
 * stdio server with NO SDK dependency — so connect/list/call/close, per-call
 * timeouts, and crash-mid-call are proven against actual child processes, not
 * mocks. Also locks the pure tool-name mangling contract (advertisedMcpToolName
 * + Map round-trip — the registry never string-parses an advertised name back).
 */
import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  connectStdioMcp,
  advertisedMcpToolName,
  mcpContentToText,
  type McpClient,
} from '../src/mcp-client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

// Must match the literal in fake-mcp-server.mjs (never import the fixture — it
// grabs stdin at module load).
const WEIRD_TOOL_NAME =
  'weird.tool:name/with spaces and a very long suffix padding it well past the sixty-four character limit'

const openClients: McpClient[] = []

async function connectFixture(): Promise<McpClient> {
  const client = await connectStdioMcp('fake', {
    command: process.execPath,
    args: [FIXTURE],
    env: {},
  })
  openClients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(c => c.close()))
})

/** Poll until the pid is gone (Windows child teardown has latency). */
async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // ESRCH — gone
    }
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

describe('connectStdioMcp against the real fixture', () => {
  it('connects, lists tools, and round-trips a call', async () => {
    const client = await connectFixture()
    const tools = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('echo')
    expect(names).toContain('sleep')
    expect(names).toContain('crash')
    expect(names).toContain(WEIRD_TOOL_NAME)
    const echo = tools.find(t => t.name === 'echo')!
    expect(echo.description).toBe('Echo text back')
    expect(echo.inputSchema).toMatchObject({ type: 'object' })

    const res = await client.callTool('echo', { text: 'round trip' })
    expect(res.isError).toBe(false)
    expect(mcpContentToText(res.content)).toBe('round trip')
  })

  it('surfaces an isError tool result without throwing', async () => {
    const client = await connectFixture()
    const res = await client.callTool('fail', {})
    expect(res.isError).toBe(true)
    expect(mcpContentToText(res.content)).toBe('deliberate failure')
  })

  it('close() kills the child process', async () => {
    const client = await connectFixture()
    const pid = client.pid()
    expect(pid).toBeTypeOf('number')
    await client.close()
    expect(await waitForExit(pid!)).toBe(true)
    // Idempotent: a second close is a no-op, never a throw.
    await expect(client.close()).resolves.toBeUndefined()
  })

  it('enforces the per-call timeout', async () => {
    const client = await connectFixture()
    const started = Date.now()
    await expect(
      client.callTool('sleep', { ms: 10_000 }, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout|timed out/i)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('rejects (not hangs) when the server crashes mid-call', async () => {
    const client = await connectFixture()
    await expect(client.callTool('crash', {})).rejects.toThrow()
  })

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      connectStdioMcp('bad', {
        command: 'definitely-not-a-real-binary-k-lane-b',
        args: [],
        env: {},
      }),
    ).rejects.toThrow()
  })
})

describe('advertisedMcpToolName (mangling contract)', () => {
  it('passes a valid name through as mcp__<server>__<tool>', () => {
    expect(advertisedMcpToolName('kstore', 'get_lesson')).toBe('mcp__kstore__get_lesson')
  })

  it('sanitizes + hash-suffixes an invalid/long name within 64 chars', () => {
    const a = advertisedMcpToolName('fake', WEIRD_TOOL_NAME)
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a.startsWith('mcp__fake__weird_tool')).toBe(true)
    expect(a).toMatch(/_[0-9a-f]{6}$/)
  })

  it('is deterministic and collision-resistant for near-identical raw names', () => {
    const long = 'x'.repeat(80)
    const a1 = advertisedMcpToolName('srv', `${long}a`)
    const a2 = advertisedMcpToolName('srv', `${long}b`)
    expect(a1).toBe(advertisedMcpToolName('srv', `${long}a`)) // deterministic
    expect(a1).not.toBe(a2) // hash keeps truncation-identical names distinct
  })

  it('round-trips through a Map (the registry pattern — no string parsing)', () => {
    const tools: Array<{ server: string; tool: string }> = [
      { server: 'kstore', tool: 'get_lesson' },
      { server: 'fake', tool: WEIRD_TOOL_NAME },
      { server: 'a', tool: 'x'.repeat(100) },
    ]
    const map = new Map(tools.map(t => [advertisedMcpToolName(t.server, t.tool), t]))
    expect(map.size).toBe(tools.length)
    for (const t of tools) {
      expect(map.get(advertisedMcpToolName(t.server, t.tool))).toEqual(t)
    }
  })
})

describe('mcpContentToText', () => {
  it('joins text blocks and stringifies non-text blocks', () => {
    expect(
      mcpContentToText([
        { type: 'text', text: 'a' },
        { type: 'image', data: 'zz' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\n{"type":"image","data":"zz"}\nb')
  })

  it('tolerates strings, null, and objects', () => {
    expect(mcpContentToText('plain')).toBe('plain')
    expect(mcpContentToText(null)).toBe('')
    expect(mcpContentToText({ k: 1 })).toBe('{"k":1}')
  })
})
