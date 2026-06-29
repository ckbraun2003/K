/**
 * Campaign S3 — kstore stdio MCP server, black-box over JSON-RPC (LOCK / gating).
 *
 * Spawns core/src/mcp/k-store-server.ts as a real child process (the way a managed
 * run launches it via `claude --mcp-config`) and speaks newline-delimited MCP
 * JSON-RPC 2.0 over stdin/stdout. Asserts the TRANSPORT + ERROR-HANDLING contract
 * S3 owns:
 *   - initialize / tools/list / tools/call round-trips against the INJECTED
 *     K_DATA_DIR + K_RUN_ID (the server opens that k.db and resolves that run);
 *   - KStoreError messages are caller-facing; any OTHER thrown error is MASKED to a
 *     generic message + isError, with the detail on stderr only (no SQLite leak);
 *   - SDK first-pass input validation → isError "Input validation error" result;
 *   - unknown tool name → isError CallToolResult; unknown METHOD → JSON-RPC -32601;
 *   - stdout carries ONLY well-formed JSON-RPC across every error path;
 *   - K_RUN_ID absent / bogus degrade to a null owner + a clean not_in_workflow.
 *
 * Findings: S3-003..S3-009 (testing/findings/S3-kstore-mcp.md). All GREEN.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { v4 as uuid } from 'uuid'
import Database from 'better-sqlite3'
import { db, runsDb, projectsDb, workflowRunsDb } from '../src/db.js'
import { kStoreTools } from '../src/mcp/k-store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../src/mcp/k-store-server.ts')
const CORE = path.resolve(HERE, '..')

interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  result?: any
  error?: { code: number; message: string }
}

interface Client {
  child: ChildProcess
  rpc(method: string, params?: unknown): Promise<RpcMessage>
  notify(method: string, params?: unknown): void
  call(name: string, args?: unknown): Promise<RpcMessage>
  initialize(): Promise<RpcMessage>
  stdoutLines: string[]
  badStdoutLines: string[]
  stderr(): string
  stop(): void
}

/** Spawn the server with `env` overlaid on process.env (undefined values deleted). */
async function startServer(overrides: Record<string, string | undefined>): Promise<Client> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides }
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete env[k]
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    cwd: CORE,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutLines: string[] = []
  const badStdoutLines: string[] = []
  const pending = new Map<number, (m: RpcMessage) => void>()
  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      stdoutLines.push(line)
      try {
        const m = JSON.parse(line) as RpcMessage
        if (m.id != null && pending.has(m.id as number)) {
          pending.get(m.id as number)!(m)
          pending.delete(m.id as number)
        }
      } catch {
        // A non-JSON stdout line is a corrupt channel — recorded for the assertion.
        badStdoutLines.push(line)
      }
    }
  })
  let stderrBuf = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (d: string) => {
    stderrBuf += d
  })

  let nextId = 1
  const rpc = (method: string, params?: unknown): Promise<RpcMessage> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 15_000)
      pending.set(id, m => {
        clearTimeout(timer)
        resolve(m)
      })
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method: string, params?: unknown): void => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  const client: Client = {
    child,
    rpc,
    notify,
    call: (name, args) => rpc('tools/call', args === undefined ? { name } : { name, arguments: args }),
    stdoutLines,
    badStdoutLines,
    stderr: () => stderrBuf,
    stop: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
    async initialize() {
      const res = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 's3-test', version: '0' },
      })
      notify('notifications/initialized')
      return res
    },
  }
  return client
}

const text = (m: RpcMessage): string => String(m.result?.content?.[0]?.text ?? '')
const parsed = (m: RpcMessage): any => JSON.parse(text(m))
const NO_LEAK = /sqlite|no such table|constraint|drop table|syntax error/i

// ── Block 1: round-trips against an injected, seeded run + workflow ────────────
describe('S3 server: initialize / tools/list / tools/call round-trips', () => {
  const PROJECT_ID = uuid()
  const RUN_WF = uuid()
  const WF_ID = uuid()
  const createdWorkItemIds: string[] = []
  const createdLessonIds: string[] = []
  let cx: Client

  beforeAll(async () => {
    projectsDb.insertProject.run({
      id: PROJECT_ID,
      name: `s3-srv-${PROJECT_ID.slice(0, 8)}`,
      localPath: '/tmp/s3-srv',
      githubRemote: null,
      workspaceManaged: 0,
      bibleDir: 'docs/bible',
      createdAt: Date.now(),
    })
    runsDb.insertRun.run({
      id: RUN_WF,
      prompt: 's3 server fixture',
      cwd: '/tmp/s3-srv',
      worktree: null,
      status: 'running',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      projectId: PROJECT_ID,
      createdAt: Date.now(),
    })
    workflowRunsDb.insertWorkflowRun.run({
      id: WF_ID,
      projectId: PROJECT_ID,
      runId: RUN_WF,
      taskIds: '[]',
      mode: 'combined',
      status: 'running',
      createdAt: Date.now(),
      completedAt: null,
    })
    // The child opens the SAME injected k.db and resolves the SAME run id.
    cx = await startServer({ K_DATA_DIR: process.env.K_DATA_DIR, K_RUN_ID: RUN_WF })
  }, 30_000)

  afterAll(() => {
    cx?.stop()
    for (const id of createdWorkItemIds) db.prepare('DELETE FROM work_items WHERE id = ?').run(id)
    for (const id of createdLessonIds) db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
    db.prepare('DELETE FROM workflow_steps WHERE workflow_run_id = ?').run(WF_ID)
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(WF_ID)
    db.prepare('DELETE FROM runs WHERE id = ?').run(RUN_WF)
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT_ID)
  })

  it('initialize returns the kstore serverInfo and echoes the protocol version', async () => {
    const res = await cx.initialize()
    expect(res.result.serverInfo).toEqual({ name: 'kstore', version: '0.0.1' })
    expect(res.result.protocolVersion).toBe('2024-11-05')
  }, 30_000)

  it('tools/list advertises exactly the registry tools, with a typed input schema', async () => {
    const res = await cx.rpc('tools/list', {})
    const names = (res.result.tools as Array<{ name: string }>).map(t => t.name).sort()
    expect(names).toEqual(kStoreTools.map(t => t.name).sort())
    const wic = (res.result.tools as Array<any>).find(t => t.name === 'work_item_create')
    expect(wic.inputSchema.required).toEqual(['title'])
    expect(wic.inputSchema.properties.title.type).toBe('string')
  }, 30_000)

  it('work_item_create round-trips and resolves the injected K_RUN_ID as owner (S3-008)', async () => {
    const res = await cx.call('work_item_create', { title: 'server round-trip' })
    expect(res.result.isError).toBeFalsy()
    const item = parsed(res)
    createdWorkItemIds.push(item.id)
    expect(item.runId).toBe(RUN_WF)
    expect(item.status).toBe('open')
  }, 30_000)

  it('lesson_propose / workflow_step_set / workflow_status_set round-trip', async () => {
    const lesson = await cx.call('lesson_propose', { lesson: 'server: propose a lesson' })
    expect(lesson.result.isError).toBeFalsy()
    createdLessonIds.push(parsed(lesson).id)
    expect(parsed(lesson).status).toBe('pending')

    const step = await cx.call('workflow_step_set', { label: 'Build', kind: 'task', status: 'in_progress' })
    expect(step.result.isError).toBeFalsy()
    expect(parsed(step).workflowRunId).toBe(WF_ID)

    const status = await cx.call('workflow_status_set', { status: 'completed' })
    expect(status.result.isError).toBeFalsy()
    expect(parsed(status)).toEqual({ ok: true, status: 'completed' })
  }, 30_000)

  it('a KStoreError surfaces verbatim with isError:true — NOT masked (S3-004)', async () => {
    const res = await cx.call('work_item_update', { id: uuid(), status: 'done' })
    expect(res.result.isError).toBe(true)
    expect(text(res)).toMatch(/not found/i)
    expect(text(res)).not.toMatch(/internal error/i)
    expect(text(res)).not.toMatch(NO_LEAK)
  }, 30_000)

  it('SDK first-pass validation rejects bad args as an isError result (S3-005)', async () => {
    const wrongType = await cx.call('work_item_create', { title: 123 })
    expect(wrongType.result.isError).toBe(true)
    expect(text(wrongType)).toMatch(/input validation error/i)
    expect(text(wrongType)).not.toMatch(NO_LEAK)

    const missing = await cx.call('work_item_create', {})
    expect(missing.result.isError).toBe(true)
    expect(text(missing)).toMatch(/input validation error/i)

    const oversize = await cx.call('work_item_create', { title: 'a'.repeat(501) })
    expect(oversize.result.isError).toBe(true)
    expect(text(oversize)).toMatch(/input validation error/i)
  }, 30_000)

  it('extra args are stripped server-side and the call still succeeds (S3-002)', async () => {
    const res = await cx.call('work_item_create', { title: 'extra-args ok', bogus: 'y', evil: { a: 1 } })
    expect(res.result.isError).toBeFalsy()
    const item = parsed(res)
    createdWorkItemIds.push(item.id)
    expect(item.bogus).toBeUndefined()
    expect(item.title).toBe('extra-args ok')
  }, 30_000)

  it('an unknown TOOL name is an isError result, not a JSON-RPC error (S3-006)', async () => {
    const res = await cx.call('no_such_tool', {})
    expect(res.error).toBeUndefined()
    expect(res.result.isError).toBe(true)
    expect(text(res)).toMatch(/not found/i)
  }, 30_000)

  it('an unknown METHOD is a top-level JSON-RPC -32601 error (S3-006)', async () => {
    const res = await cx.rpc('bogus/method', {})
    expect(res.result).toBeUndefined()
    expect(res.error?.code).toBe(-32601)
  }, 30_000)

  it('stdout carried ONLY well-formed JSON-RPC across every path so far (S3-007)', () => {
    expect(cx.badStdoutLines).toEqual([])
    expect(cx.stdoutLines.length).toBeGreaterThan(0)
    for (const line of cx.stdoutLines) {
      const m = JSON.parse(line) as RpcMessage
      expect(m.jsonrpc).toBe('2.0')
    }
  })
})

// ── Block 2: internal-error masking via fault injection (DROP TABLE) ───────────
describe('S3 server: a non-KStoreError is masked, detail to stderr only (S3-003)', () => {
  const dir = path.join(os.tmpdir(), `k-s3-mask-${uuid()}`)
  let cx: Client

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true })
    // Boot the server (it creates the schema in `dir`), then yank the table out
    // from under it via a side connection so the next insert throws a SqliteError.
    cx = await startServer({ K_DATA_DIR: dir, K_RUN_ID: undefined })
    await cx.initialize()
    const side = new Database(path.join(dir, 'k.db'))
    side.exec('DROP TABLE work_items')
    side.close()
  }, 30_000)

  afterAll(() => {
    cx?.stop()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* file may still be locked on Windows — best effort */
    }
  })

  it('returns a generic masked message + isError, with no schema/SQLite leak on stdout', async () => {
    const res = await cx.call('work_item_create', { title: 'will hit a dropped table' })
    expect(res.result.isError).toBe(true)
    expect(text(res)).toBe('kstore: internal error in work_item_create.')
    expect(text(res)).not.toMatch(NO_LEAK)
  }, 30_000)

  it('logs the real fault to stderr (never stdout) and keeps the channel clean', async () => {
    expect(cx.stderr()).toMatch(/\[kstore\] work_item_create failed/i)
    expect(cx.stderr()).toMatch(NO_LEAK) // the SqliteError detail IS on stderr
    expect(cx.badStdoutLines).toEqual([])
    for (const line of cx.stdoutLines) expect((JSON.parse(line) as RpcMessage).jsonrpc).toBe('2.0')
  }, 30_000)
})

// ── Block 3: K_RUN_ID resolution — absent and bogus both degrade cleanly ───────
describe('S3 server: K_RUN_ID absent / bogus degrade to a null owner (S3-008, S3-009)', () => {
  const dirAbsent = path.join(os.tmpdir(), `k-s3-absent-${uuid()}`)
  const dirBogus = path.join(os.tmpdir(), `k-s3-bogus-${uuid()}`)
  let absent: Client
  let bogus: Client

  beforeAll(async () => {
    fs.mkdirSync(dirAbsent, { recursive: true })
    fs.mkdirSync(dirBogus, { recursive: true })
    absent = await startServer({ K_DATA_DIR: dirAbsent, K_RUN_ID: undefined })
    bogus = await startServer({ K_DATA_DIR: dirBogus, K_RUN_ID: uuid() })
    await absent.initialize()
    await bogus.initialize()
  }, 30_000)

  afterAll(() => {
    absent?.stop()
    bogus?.stop()
    for (const d of [dirAbsent, dirBogus]) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  it('with K_RUN_ID absent, work_item_create succeeds with a null owner', async () => {
    const res = await absent.call('work_item_create', { title: 'no run id' })
    expect(res.result.isError).toBeFalsy()
    expect(parsed(res).runId).toBeNull()
  }, 30_000)

  it('with K_RUN_ID absent, status-writes return a clean not_in_workflow notice (not isError)', async () => {
    const status = await absent.call('workflow_status_set', { status: 'running' })
    expect(status.result.isError).toBeFalsy()
    expect(parsed(status)).toMatchObject({ ok: false, reason: 'not_in_workflow' })

    const step = await absent.call('workflow_step_set', { label: 'x', kind: 'phase', status: 'pending' })
    expect(step.result.isError).toBeFalsy()
    expect(parsed(step)).toMatchObject({ ok: false, reason: 'not_in_workflow' })
  }, 30_000)

  it('with a bogus K_RUN_ID (no matching run row), it degrades to null owner — no FK/masked error', async () => {
    const res = await bogus.call('work_item_create', { title: 'bogus run id' })
    expect(res.result.isError).toBeFalsy()
    expect(parsed(res).runId).toBeNull()
  }, 30_000)
})
