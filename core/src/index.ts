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
import { capabilitiesRoutes } from './routes/capabilities.js'
import { skillCreatorRoutes } from './routes/skill-creator.js'
import { chiefRoutes } from './routes/chief.js'
import { orchestratorsRoutes } from './routes/orchestrators.js'
import { profilesRoutes } from './routes/profiles.js'
import { workflowsRoutes } from './routes/workflows.js'
import { settingsRoutes } from './routes/settings.js'
import { ollamaRoutes } from './routes/ollama.js'
import { modelsRoutes } from './routes/models.js'
import { voiceRoutes } from './routes/voice.js'
import { evalsRoutes } from './routes/evals.js'
import { memoryRoutes } from './routes/memory.js'
import { kRoutes } from './routes/k.js'
import { reviewRoutes } from './routes/review.js'
import { verifyRoutes } from './routes/verify.js'
import { rewindRoutes } from './routes/rewind.js'
import { planRoutes } from './routes/plan.js'
import { inboxRoutes } from './routes/inbox.js'
import { notificationsRoutes } from './routes/notifications.js'
import { mergeRoutes } from './routes/merge.js'
import { feedRoutes } from './routes/feed.js'
import { systemRoutes } from './routes/system.js'
import { registerRunVerify } from './run-verify.js'
import { registerNotifications } from './notify.js'
import { sweepCheckpointRefs } from './checkpoints.js'
import { startEventListener, startScheduler, seedBuiltinSkills } from './skills.js'
import { syncHostDiscovery } from './host-discovery.js'
import { seedProfiles } from './profiles.js'
import { seedWorkflowDefinitions } from './workflow-defs.js'
import { seedEvalSystems } from './eval/store.js'
import { ensureHarnessBibleRegistered } from './bible.js'
import { seedUiDemo } from './ui-artifact.js'
import { registerGraphAutoReindex } from './graph.js'
import { startChiefWake } from './chief-wake.js'
import { startLeadDispatchRelay } from './lead-dispatch-relay.js'
import { getProject, listProjects, warnStaleProjectPaths } from './projects.js'
import { reconcileOnBoot, REPO_ROOT } from './supervisor.js'
import { startOllamaProbe } from './router.js'
import { acquireInstanceLock } from './instance-lock.js'
import { DATA_DIR, runsDb } from './db.js'
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
import { terminalGate, createTerminalSession, scrubSensitiveEnv, installConptyStderrFilter, type SpawnPty } from './terminal.js'
import { credentialPosture } from './agent-config.js'
import fastifyStatic from '@fastify/static'
import { resolveWebDist, isPublicAssetPath } from './web-static.js'

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
// Same, for the E-04 run-verify engine (terminal-'done' → recipe battery; W0 stub).
let stopRunVerify: (() => void) | null = null
// Same, for the E-19 notification engine (rules-gated run/verify → notifications; W0 stub).
let stopNotifications: (() => void) | null = null
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

  // When a built web SPA is present (packaged desktop app, or `pnpm build` +
  // `start`), core serves it SAME-ORIGIN so the browser loads the bundle and its
  // relative `/api` + same-host `/ws` from one origin — no CORS, no cross-port
  // wiring. null in dev (Vite serves the SPA) → behavior byte-identical to before.
  const webDist = resolveWebDist()

  // ── Auth hook ─────────────────────────────────────────────────────────────

  app.addHook('onRequest', async (req, reply) => {
    // Skip auth for WS upgrade and health
    if (isAuthExempt(req.url)) return
    // Skip auth for PUBLIC SPA assets when we're serving the bundle: the built
    // bundle bakes no token (same as Vite serving it), and the data plane stays
    // gated — every route is `/api/*` (bearer) or `/ws*` (query token), which
    // isPublicAssetPath excludes. Gated on webDist so dev auth is unchanged.
    if (webDist && isPublicAssetPath(req.method, req.url)) return
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
  await app.register(capabilitiesRoutes)
  await app.register(skillCreatorRoutes)
  await app.register(chiefRoutes)
  await app.register(orchestratorsRoutes)
  await app.register(profilesRoutes)
  await app.register(workflowsRoutes)
  await app.register(settingsRoutes)
  await app.register(ollamaRoutes)
  await app.register(modelsRoutes)
  await app.register(voiceRoutes)
  await app.register(evalsRoutes)
  await app.register(memoryRoutes)
  await app.register(kRoutes)
  await app.register(reviewRoutes)
  await app.register(verifyRoutes)
  await app.register(rewindRoutes)
  await app.register(planRoutes)
  await app.register(inboxRoutes)
  await app.register(notificationsRoutes)
  await app.register(mergeRoutes)
  await app.register(feedRoutes)
  await app.register(systemRoutes)

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
      // F-088: node-pty's ConPTY teardown can print a benign `AttachConsole failed`
      // stack to stderr. Install the narrow filter now that a pty is actually in use
      // (idempotent — only the first terminal session installs it).
      installConptyStderrFilter()
      spawnPty = (shell, cols, rows) =>
        pty.spawn(shell, [], {
          name: 'xterm-color',
          cols,
          rows,
          cwd: process.env.HOME ?? process.cwd(),
          // SCRUBBED env: the browser shell must never inherit the core's own
          // credentials (ANTHROPIC_API_KEY / HARNESS_TOKEN / TERMINAL_TOKEN /
          // cloud keys, …), or `echo $ANTHROPIC_API_KEY` would leak them.
          env: scrubSensitiveEnv(process.env),
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

  // ── Same-origin SPA (registered LAST so specific /api, /ws, /health routes win
  //    over the static wildcard) ─────────────────────────────────────────────
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false })
    // SPA fallback: a public GET/HEAD that matched no file or API route serves
    // index.html so hash-router deep links + client routes resolve. API/WS misses
    // stay a JSON 404 (isPublicAssetPath excludes /api and /ws).
    app.setNotFoundHandler((req, reply) => {
      if (isPublicAssetPath(req.method, req.url)) {
        return reply.type('text/html').sendFile('index.html')
      }
      return reply.status(404).send({ error: 'not found' })
    })
  }

  app.addHook('onClose', () => {
    stopGithubPoller()
    stopGraphAutoReindex?.()
    stopRunVerify?.()
    stopNotifications?.()
    stopChiefWake?.()
    stopLeadDispatchRelay?.()
    releaseInstanceLock?.()
  })
  return app
}

/**
 * Signals on which the single-instance lock is released before exit (F-092). SIGINT
 * (Ctrl-C) and SIGTERM (kill / `node --watch` restart) apply everywhere; SIGBREAK
 * (Windows Ctrl-Break) is added ONLY on win32 — POSIX has no such signal name and
 * registering it there throws. A HARD kill (Windows `Stop-Process` / POSIX SIGKILL) is
 * UNCATCHABLE by design and cannot release the lock here; the next boot's dead-pid
 * reclaim in acquireInstanceLock() detects and takes over the stale lock — correct and
 * self-healing. Pure + parameterized so the signal set is unit-testable on any platform.
 */
export function lockReleaseSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
  if (platform === 'win32') sigs.push('SIGBREAK')
  return sigs
}

/**
 * Wire `release` to run on process 'exit' and on each termination signal
 * (lockReleaseSignals) so the instance lock is freed on Ctrl-C / kill / Windows
 * Ctrl-Break as well as the Fastify onClose graceful path. The 'exit' handler must be
 * synchronous. Exported so the signal wiring — including the Windows SIGBREAK handler
 * (F-092) — is unit-testable without booting the server.
 */
export function installLockReleaseHandlers(release: () => void): void {
  process.once('exit', () => release())
  for (const sig of lockReleaseSignals()) {
    process.once(sig, () => { release(); process.exit(0) })
  }
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
  // non-loopback HOST with a weak/default TERMINAL_TOKEN — AND, even with a STRONG
  // token, exposing the shell beyond loopback requires an explicit
  // TERMINAL_ALLOW_REMOTE opt-in so an accidental LAN bind can't expose it.
  const unsafeTerminal = unsafeTerminalBootReason(
    HOST,
    process.env.ENABLE_TERMINAL === 'true',
    TERMINAL_TOKEN,
    process.env.TERMINAL_ALLOW_REMOTE === 'true',
  )
  if (unsafeTerminal) {
    console.error(`\n✖ ${unsafeTerminal}\n`)
    process.exit(1)
  }

  // Credential posture (F-064/F-090): make it VISIBLE once at boot whether K is
  // authenticating with a managed token or falling back to copying host
  // ~/.claude credentials into every run (never prints the credential itself).
  const posture = credentialPosture()
  if (posture === 'host-fallback') {
    console.warn(
      '⚠ K auth: no managed token set — runs will COPY host ~/.claude/.credentials.json ' +
        '(dogfooding fallback). Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for a managed ' +
        'token, or set K_DISABLE_HOST_CREDENTIAL_FALLBACK=true to fail closed instead.',
    )
  } else if (posture === 'disabled') {
    console.warn(
      '⚠ K auth: no managed token and K_DISABLE_HOST_CREDENTIAL_FALLBACK is set — the host-credential ' +
        'fallback is OFF, so runs will be UNAUTHENTICATED until a managed token is set.',
    )
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
  // Release the lock on exit + termination signals (Fastify onClose covers a graceful
  // close; these cover Ctrl-C / kill / node --watch restart / Windows Ctrl-Break). A
  // HARD Stop-Process / SIGKILL is uncatchable and cannot release the lock here — the
  // next boot's dead-pid reclaim in acquireInstanceLock() self-heals the stale lock.
  installLockReleaseHandlers(() => releaseInstanceLock?.())

  // Crash recovery: mark runs left `running`/`queued` by a prior crash as
  // interrupted and prune orphaned worktrees, before serving traffic.
  reconcileOnBoot()
  // P1: prune checkpoint refs for runs whose rows were deleted (best-effort, async;
  // roots = the harness repo + every registered project).
  void sweepCheckpointRefs(
    [REPO_ROOT, ...listProjects().map(p => p.localPath)],
    (runId) => runsDb.getRun.get(runId) !== undefined,
  )
    .then(n => { if (n > 0) console.log(`[checkpoints] pruned ${n} orphaned checkpoint ref(s)`) })
    .catch(() => { /* best-effort */ })
  // F-033: warn once per registered project whose localPath has vanished on disk, so
  // a silently-broken project surfaces in the boot log (its workspace actions are
  // disabled in the UI). CLAIM-11-9: one warn/boot.
  warnStaleProjectPaths()

  const app = await buildApp()
  // Bible is recompiled on request + on merge/push (see ensureHarnessBibleRegistered);
  // boot only registers a missing row (no HTML rewrite → no per-boot churn).
  await ensureHarnessBibleRegistered()
  await seedUiDemo()  // rebuilt every boot — deterministic HTML, git-tracked
  seedBuiltinSkills() // ensure the authored agent-config/skills/* appear in the Skills tab
  // D-069 host discovery: refresh the capability catalog from the host layer (user/
  // project/plugin skills + host MCP servers). Guarded — a broken host install must
  // never brick boot; everything discovered lands default-DISABLED (enabled=0).
  try {
    const scan = syncHostDiscovery()
    console.log(
      `[discovery] host capability scan: skills +${scan.skills.discovered} ~${scan.skills.updated} -${scan.skills.missing}, ` +
        `mcp +${scan.mcpServers.discovered} ~${scan.mcpServers.updated} -${scan.mcpServers.missing}` +
        (scan.warnings.length ? ` (${scan.warnings.length} warning(s))` : ''),
    )
  } catch (e) {
    console.warn('[discovery] host capability scan failed (continuing without host catalog):', e)
  }
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
  // E-04 run-verify engine seam (W0 stub — Lane B lands the real trigger).
  stopRunVerify = registerRunVerify(getProject)
  // E-19 notification engine seam (W0 stub — Lane B lands the real pipeline).
  stopNotifications = registerNotifications()
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
