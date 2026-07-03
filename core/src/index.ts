/**
 * Harness Core — Fastify + WebSocket gateway
 *
 * Startup sequence:
 *   1. Init SQLite (db.ts runs on import)
 *   2. Compile project bible (sections + live data → HTML) + seed ui-demo
 *   3. Register REST routes
 *   4. Register WS gateway (subscribe to EventBus, push to clients)
 *   5. Listen
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket, { type SocketStream } from '@fastify/websocket'
import { eventBus } from './events.js'
import { runsRoutes } from './routes/runs.js'
import { artifactsRoutes } from './routes/artifacts.js'
import { metricsRoutes } from './routes/metrics.js'
import { projectsRoutes } from './routes/projects.js'
import { skillsRoutes } from './routes/skills.js'
import { chiefRoutes } from './routes/chief.js'
import { orchestratorsRoutes } from './routes/orchestrators.js'
import { workflowsRoutes } from './routes/workflows.js'
import { settingsRoutes } from './routes/settings.js'
import { ollamaRoutes } from './routes/ollama.js'
import { modelsRoutes } from './routes/models.js'
import { voiceRoutes } from './routes/voice.js'
import { evalsRoutes } from './routes/evals.js'
import { memoryRoutes } from './routes/memory.js'
import { kRoutes } from './routes/k.js'
import { startEventListener, startScheduler, seedBuiltinSkills } from './skills.js'
import { seedProfiles } from './profiles.js'
import { seedWorkflowDefinitions } from './workflow-defs.js'
import { seedEvalSystems } from './eval/store.js'
import { compileBible } from './bible.js'
import { seedUiDemo } from './ui-artifact.js'
import { registerGraphAutoReindex } from './graph.js'
import { startChiefWake } from './chief-wake.js'
import { startLeadDispatchRelay } from './lead-dispatch-relay.js'
import { getProject } from './projects.js'
import { reconcileOnBoot } from './supervisor.js'
import { startOllamaProbe } from './router.js'
import { acquireInstanceLock } from './instance-lock.js'
import { DATA_DIR } from './db.js'
import type { WsMessage, AgentEvent, Run } from '@k/shared'
import { startGithubPoller, stopGithubPoller } from './github.js'
import {
  isAuthExempt,
  resolveHarnessToken,
  tokensEqual,
  wsTokenOk,
  unsafeBootReason,
  unsafeTerminalBootReason,
  type ResolvedToken,
} from './auth.js'
import { terminalGate, createTerminalSession, type SpawnPty } from './terminal.js'

const PORT = Number(process.env.PORT ?? 3001)
// loopback by default — Phase 0's security posture assumes localhost-only;
// set HOST=0.0.0.0 explicitly to expose on the network
const HOST = process.env.HOST ?? '127.0.0.1'
// Resolve the harness token: HARNESS_TOKEN env → persisted file → generated +
// persisted (first run). No insecure hard-coded default; the safety gate in
// start() refuses to bind a non-loopback HOST with a weak/empty token.
const RESOLVED_TOKEN: ResolvedToken = resolveHarnessToken()
const BEARER_TOKEN = RESOLVED_TOKEN.token
// Separate, narrower credential for the web terminal. It is embedded in the web
// bundle (vite.config.ts) so a leaked bundle grants ONLY terminal access — never
// the full-REST HARNESS_TOKEN. Default-off feature; loopback posture applies.
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN ?? 'dev-terminal-token'

// Captured at bootstrap so the Fastify onClose hook can tear down the
// auto-reindex EventBus subscription (set in start(); undefined in tests).
let stopGraphAutoReindex: (() => void) | undefined
// Same, for the Chief autonomous wake (cron tick + run-completion subscription).
let stopChiefWake: (() => void) | undefined
// Same, for the MAIN-process lead-dispatch relay (drains the child-recorded intent queue).
let stopLeadDispatchRelay: (() => void) | undefined
// Releases the single-instance lock file (set in start(); undefined in tests).
let releaseInstanceLock: (() => void) | undefined

/**
 * Build the Fastify app: CORS, WS plugin, auth hook, health, REST routes, and
 * the WebSocket gateway. Returns the instance WITHOUT listening — so the same
 * wiring is exercised by `app.inject(...)` in tests and by the bootstrap below
 * in production. Side-effecting boot steps (reconcile, bible compile, listen,
 * poller) live in `start()`, not here. Non-behavioral extraction.
 */
export async function buildApp() {
  // disableRequestLogging: the default per-request log serializes ALL headers,
  // which would leak `Authorization: Bearer <token>`. The app has its own
  // run/audit logging, so the per-request line is not needed.
  const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true })

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  })

  await app.register(websocket)

  // ── Auth hook ─────────────────────────────────────────────────────────────

  app.addHook('onRequest', async (req, reply) => {
    // Skip auth for WS upgrade and health
    if (isAuthExempt(req.url)) return
    const auth = req.headers.authorization
    // Constant-time compare against the expected `Bearer <token>` header to
    // avoid a timing oracle on the token bytes.
    if (!auth || !tokensEqual(auth, `Bearer ${BEARER_TOKEN}`)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
  })

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ ok: true, ts: Date.now() }))

  // ── REST routes ─────────────────────────────────────────────────────────────

  await app.register(runsRoutes)
  await app.register(artifactsRoutes)
  await app.register(metricsRoutes)
  await app.register(projectsRoutes)
  await app.register(skillsRoutes)
  await app.register(chiefRoutes)
  await app.register(orchestratorsRoutes)
  await app.register(workflowsRoutes)
  await app.register(settingsRoutes)
  await app.register(ollamaRoutes)
  await app.register(modelsRoutes)
  await app.register(voiceRoutes)
  await app.register(evalsRoutes)
  await app.register(memoryRoutes)
  await app.register(kRoutes)

  // ── WebSocket gateway ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsClients = new Set<any>()

  app.get('/ws', { websocket: true }, (connection: SocketStream, req) => {
    const socket = connection.socket

    // The event gateway streams ALL agent activity, so it must be authenticated.
    // A browser WS upgrade can't carry an Authorization header, so the token
    // rides in the `?token=` query param (mirroring /ws/terminal) and is checked
    // with a constant-time compare BEFORE the socket is subscribed to the bus.
    const wsToken = ((req.query ?? {}) as { token?: string }).token
    if (!wsTokenOk(wsToken, BEARER_TOKEN)) {
      // 4401: application-level "unauthorized" close (4000–4999 is app-reserved).
      socket.close(4401, 'unauthorized')
      return
    }

    wsClients.add(socket)

    function send(msg: WsMessage) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg))
      }
    }

    // Subscribe to EventBus
    const unsubEvent = eventBus.onEvent((e: AgentEvent) => {
      send({ type: 'event', event: e })
    })
    const unsubRun = eventBus.onRunUpdate((r: Run) => {
      send({ type: 'run_update', run: r })
    })
    const unsubBroadcast = eventBus.onBroadcast((m: WsMessage) => send(m))

    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage
        if (msg.type === 'ping') send({ type: 'pong' })
      } catch { /* ignore */ }
    })

    function cleanup() {
      wsClients.delete(socket)
      unsubEvent()
      unsubRun()
      unsubBroadcast()
    }

    socket.on('close', cleanup)
    // unhandled 'error' would throw and can skip 'close' — clean up here too
    // (cleanup is idempotent: Set.delete + unsubscribe are safe to run twice)
    socket.on('error', (err: Error) => {
      console.warn('[ws] socket error:', err.message)
      cleanup()
    })
  })

  // ── Web terminal (opt-in, sensitive) ─────────────────────────────────────────
  // Default OFF. Gated on ENABLE_TERMINAL=true + a matching `token` query param
  // (browsers can't send an auth header on a WS upgrade). node-pty is imported
  // dynamically so its native binding never affects core boot, and an
  // unavailable pty degrades to a clean 'unavailable' error frame.
  app.get('/ws/terminal', { websocket: true }, async (connection: SocketStream, req) => {
    const socket = connection.socket

    const token = ((req.query ?? {}) as { token?: string }).token
    const gate = terminalGate({
      enabled: process.env.ENABLE_TERMINAL === 'true',
      token,
      expectedToken: TERMINAL_TOKEN,
    })
    if (!gate.ok) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', code: gate.code }))
      }
      socket.close()
      return
    }

    // Dynamically import node-pty: keep it off the core boot path, and degrade
    // gracefully if the native binding is missing on this platform.
    let spawnPty: SpawnPty
    try {
      const pty = await import('node-pty')
      spawnPty = (shell, cols, rows) =>
        pty.spawn(shell, [], {
          name: 'xterm-color',
          cols,
          rows,
          cwd: process.env.HOME ?? process.cwd(),
          env: process.env,
        })
    } catch {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', code: 'unavailable' }))
      }
      socket.close()
      return
    }

    const session = createTerminalSession({
      send: (f) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(f))
      },
      spawn: spawnPty,
    })

    socket.on('message', (d: Buffer | string) => session.onClientMessage(d.toString()))
    socket.on('close', () => session.dispose())
    socket.on('error', () => session.dispose())
  })

  app.addHook('onClose', () => {
    stopGithubPoller()
    stopGraphAutoReindex?.()
    stopChiefWake?.()
    stopLeadDispatchRelay?.()
    releaseInstanceLock?.()
  })
  return app
}

// ── Bootstrap + Listen ────────────────────────────────────────────────────────

async function start() {
  // Safety gate: never serve a weak/empty token on a non-loopback HOST. Checked
  // before any side effects so an unsafe config fails fast with guidance.
  const unsafe = unsafeBootReason(HOST, BEARER_TOKEN)
  if (unsafe) {
    console.error(`\n✖ ${unsafe}\n`)
    process.exit(1)
  }
  // Same gate for the web terminal: a host shell must never be reachable on a
  // non-loopback HOST with a weak/default TERMINAL_TOKEN.
  const unsafeTerminal = unsafeTerminalBootReason(
    HOST,
    process.env.ENABLE_TERMINAL === 'true',
    TERMINAL_TOKEN,
  )
  if (unsafeTerminal) {
    console.error(`\n✖ ${unsafeTerminal}\n`)
    process.exit(1)
  }

  // Single-instance lock (H1/H3): refuse a SECOND core on the same DATA_DIR before
  // any side effects. Two cores share one k.db, and reconcileOnBoot() below would
  // then cross-kill the live process's in-flight runs + steal its port. Scoped per
  // DATA_DIR, so an isolated stack (own K_DATA_DIR) is unaffected.
  const lock = acquireInstanceLock(DATA_DIR, PORT)
  if (!lock.ok) {
    const h = lock.holder
    console.error(
      `\n✖ Another K core is already running on this data dir` +
        (h ? ` (pid ${h.pid}, port ${h.port})` : '') +
        `.\n  Lock: ${lock.file}\n  Stop the other process, or use a separate K_DATA_DIR + PORT for a second stack.\n`,
    )
    process.exit(1)
  }
  releaseInstanceLock = lock.release
  // Release on process exit too (Fastify onClose covers a graceful close; these
  // cover Ctrl-C / kill / node --watch restart). 'exit' must be synchronous.
  process.once('exit', () => releaseInstanceLock?.())
  process.once('SIGINT', () => { releaseInstanceLock?.(); process.exit(0) })
  process.once('SIGTERM', () => { releaseInstanceLock?.(); process.exit(0) })

  // Crash recovery: mark runs left `running`/`queued` by a prior crash as
  // interrupted and prune orphaned worktrees, before serving traffic.
  reconcileOnBoot()

  const app = await buildApp()
  await compileBible()
  await seedUiDemo()  // ensure the Command Deck `ui-demo` artifact is present
  seedBuiltinSkills() // ensure the authored agent-config/skills/* appear in the Skills tab
  seedProfiles()      // ensure the durable agent-org profiles (K, Chief, orchestrator + leads) exist
  seedWorkflowDefinitions() // ensure the built-in named workflow templates (code-wave, investigate, refactor) exist
  // Seed the eval registry (testing/eval/* → eval_* tables) so the Evals surface has systems to run.
  // Idempotent; guarded so a missing/garbled testing/eval/ dir logs and continues rather than aborting boot.
  try {
    seedEvalSystems()
  } catch (e) {
    console.warn('[eval] seedEvalSystems failed (continuing without eval registry):', e)
  }

  await app.listen({ port: PORT, host: HOST })
  startGithubPoller()
  startEventListener()
  startScheduler()
  // Auto-reindex a project's knowledge graph after a run touching it completes
  // (debounced + guarded). Default ON; set GRAPH_AUTO_REINDEX=0 to disable.
  stopGraphAutoReindex = registerGraphAutoReindex(getProject)
  // Wake the Chief autonomously on a schedule tick + on subscribed run-completion
  // events (debounced + already-running/self-wake guarded). Default ON; CHIEF_WAKE=0.
  stopChiefWake = startChiefWake()
  // Drain the DB-backed lead-dispatch intent queue in this long-lived process (so a lead
  // run + its report-back outlive the ephemeral mgmt-server child). Default ON; LEAD_DISPATCH_RELAY=0.
  stopLeadDispatchRelay = startLeadDispatchRelay()
  startOllamaProbe()  // no-op unless ENABLE_OLLAMA; keeps router reachability fresh
  console.log(`\n⚡ Harness core running → http://localhost:${PORT}`)
  console.log(`   WebSocket gateway  → ws://localhost:${PORT}/ws`)
  logTokenStatus(RESOLVED_TOKEN)
}

/**
 * Print the token status. On first-run generation, show the full token ONCE
 * (the operator needs it to log in remotely). On every subsequent boot, print a
 * masked confirmation (last 4 chars) plus where it is stored — never the full
 * token. An explicit HARNESS_TOKEN env override is reported as masked too.
 */
function logTokenStatus(t: ResolvedToken) {
  const last4 = t.token.slice(-4)
  if (t.firstRun) {
    console.log('\n┌─────────────────────────────────────────────────────────────┐')
    console.log('│  FIRST-RUN SETUP — a strong harness token was generated.     │')
    console.log('└─────────────────────────────────────────────────────────────┘')
    console.log(`   Token : ${t.token}`)
    console.log(`   Saved : ${t.file}`)
    console.log('   Use this token to log in when accessing the dashboard remotely.')
    console.log('   It will NOT be printed again — copy it now if you need it.\n')
  } else if (t.source === 'env') {
    console.log(`   Bearer token       → set via HARNESS_TOKEN (…${last4})\n`)
  } else {
    console.log(`   Bearer token       → persisted (…${last4}) at ${t.file}\n`)
  }
}

// Skip the listen/poller bootstrap when imported for testing (K_SKIP_BOOTSTRAP),
// so tests can `import { buildApp }` and drive the app via app.inject without
// opening a socket or starting the gh poller.
if (process.env.K_SKIP_BOOTSTRAP !== '1') {
  await start()
}
