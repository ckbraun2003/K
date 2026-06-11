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
import type { WsMessage, AgentEvent, Run } from '@k/shared'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '0.0.0.0'
const BEARER_TOKEN = process.env.HARNESS_TOKEN ?? 'dev-token-change-me'

const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
})

await app.register(websocket)

// ── Auth hook ─────────────────────────────────────────────────────────────────

app.addHook('onRequest', async (req, reply) => {
  // Skip auth for WS upgrade and health
  if (req.url === '/ws' || req.url === '/health') return
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${BEARER_TOKEN}`) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
})

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, ts: Date.now() }))

// ── REST routes ───────────────────────────────────────────────────────────────

await app.register(runsRoutes)
await app.register(artifactsRoutes)
await app.register(metricsRoutes)
await app.register(projectsRoutes)

// ── WebSocket gateway ─────────────────────────────────────────────────────────

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

  socket.on('close', () => {
    wsClients.delete(socket)
    unsubEvent()
    unsubRun()
    unsubBroadcast()
  })
})

// ── Bootstrap + Listen ────────────────────────────────────────────────────────

await compileBible()

await app.listen({ port: PORT, host: HOST })
console.log(`\n⚡ Harness core running → http://localhost:${PORT}`)
console.log(`   WebSocket gateway  → ws://localhost:${PORT}/ws`)
console.log(`   Bearer token       → ${BEARER_TOKEN}\n`)
