import { WsMessageSchema, type WsMessage } from '@k/shared'
import { effectiveToken, clearSessionToken } from './auth'
import { notifyUnauthorized } from './auth-events'
import { coreWsBase } from './core-origin'

type MessageHandler = (msg: WsMessage) => void
type StatusHandler = (connected: boolean) => void

let socket: WebSocket | null = null
const handlers = new Set<MessageHandler>()
const statusHandlers = new Set<StatusHandler>()

function emitStatus(connected: boolean) {
  for (const h of statusHandlers) {
    try { h(connected) } catch { /* status handlers must not break the socket */ }
  }
}
let pingInterval: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  // The /ws gateway is authenticated by a `?token=` query param (a browser WS
  // upgrade can't send an Authorization header). In dev this is the dev token;
  // remotely it's the operator's session token. Absent → core closes with 4401.
  const token = effectiveToken()
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  // PROD: core serves the SPA same-origin, so /ws is on the page's own host:port
  // (no build-frozen port — the desktop app's dynamic core port just works). DEV:
  // Vite serves the SPA and the /ws upgrade is NOT proxied, so dial core directly
  // on VITE_CORE_PORT (the e2e swarm overrides it per isolated stack).
  const url = `${coreWsBase(window.location, {
    isDev: import.meta.env.DEV,
    corePort: import.meta.env.VITE_CORE_PORT ?? '3001',
  })}/ws${qs}`
  socket = new WebSocket(url)

  socket.onopen = () => {
    console.log('[ws] connected')
    emitStatus(true)
    pingInterval = setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), 20_000)
  }

  socket.onmessage = (e) => {
    try {
      const parsed = WsMessageSchema.safeParse(JSON.parse(e.data as string))
      if (!parsed.success) return // ignore a contract-violating message (SEAMS F5 — defensive)
      const msg: WsMessage = parsed.data
      if (msg.type === 'pong') return
      for (const h of handlers) {
        try { h(msg) } catch { /* handler errors must not kill the socket */ }
      }
    } catch { /* ignore malformed */ }
  }

  socket.onclose = (event) => {
    emitStatus(false)
    if (pingInterval) clearInterval(pingInterval)
    pingInterval = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    // 4401: core rejected our token. Reconnecting would loop forever, so drop
    // the stale token and surface the login screen via the SAME unauthorized
    // path a REST 401 uses — do NOT schedule a reconnect.
    if (event.code === 4401) {
      console.log('[ws] unauthorized (4401) — clearing token, prompting login')
      clearSessionToken()
      notifyUnauthorized()
      return
    }
    console.log('[ws] disconnected — reconnecting in 3s')
    reconnectTimer = setTimeout(connectWs, 3_000)
  }

  socket.onerror = () => socket?.close()
}

/** Tear down and reopen the socket — used after a token change (login/logout). */
export function reconnectWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (socket) {
    socket.onclose = null // suppress the auto-reconnect-in-3s from the old socket
    try { socket.close() } catch { /* already closing */ }
    socket = null
  }
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
  connectWs()
}

export function onWsMessage(handler: MessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function onWsStatus(handler: StatusHandler): () => void {
  statusHandlers.add(handler)
  return () => statusHandlers.delete(handler)
}
