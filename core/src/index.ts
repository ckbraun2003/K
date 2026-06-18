/**
 * Harness Core — Fastify + WebSocket gateway
 *
 * Startup sequence:
 *   1. Init SQLite (db.ts runs on import)
 *   2. Compile project bible (sections + live data → HTML)
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
import { compileBible } from './bible.js'
import { reconcileOnBoot } from './supervisor.js'
import type { WsMessage, AgentEvent, Run } from '@k/shared'
import { startGithubPoller, stopGithubPoller } from './github.js'
import { isAuthExempt } from './auth.js'

const PORT = Number(process.env.PORT ?? 3001)
// loopback by default — Phase 0's security posture assumes localhost-only;
// set HOST=0.0.0.0 explicitly to expose on the network
const HOST = process.env.HOST ?? '127.0.0.1'
const BEARER_TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'

/**
 * Build the Fastify app: CORS, WS plugin, auth hook, health, REST routes, and
 * the WebSocket gateway. Returns the instance WITHOUT listening — so the same
 * wiring is exercised by `app.inject(...)` in tests and by the bootstrap below
 * in production. Side-effecting boot steps (reconcile, bible compile, listen,
 * poller) live in `start()`, not here. Non-behavioral extraction.
 */
export async function buildApp() {
  const app = Fastify({ logger: { level: 'info' } })

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
    if (!auth || auth !== `Bearer ${BEARER_TOKEN}`) {
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

  // ── WebSocket gateway ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsClients = new Set<any>()

  app.get('/ws', { websocket: true }, (connection: SocketStream) => {
    const socket = connection.socket
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

  app.addHook('onClose', () => stopGithubPoller())
  return app
}

// ── Bootstrap + Listen ────────────────────────────────────────────────────────

async function start() {
  // Crash recovery: mark runs left `running`/`queued` by a prior crash as
  // interrupted and prune orphaned worktrees, before serving traffic.
  reconcileOnBoot()

  const app = await buildApp()
  await compileBible()

  await app.listen({ port: PORT, host: HOST })
  startGithubPoller()
  console.log(`\n⚡ Harness core running → http://localhost:${PORT}`)
  console.log(`   WebSocket gateway  → ws://localhost:${PORT}/ws`)
  console.log(`   Bearer token       → ${BEARER_TOKEN}\n`)
}

// Skip the listen/poller bootstrap when imported for testing (K_SKIP_BOOTSTRAP),
// so tests can `import { buildApp }` and drive the app via app.inject without
// opening a socket or starting the gh poller.
if (process.env.K_SKIP_BOOTSTRAP !== '1') {
  await start()
}
