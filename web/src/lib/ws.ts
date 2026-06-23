import type { WsMessage } from '@k/shared'
import { effectiveToken, clearSessionToken } from './auth'
import { notifyUnauthorized } from './auth-events'

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
  // Core port defaults to 3001; the e2e harness injects VITE_CORE_PORT to point
  // each isolated web stack at its own core. The /ws upgrade is direct (not
  // proxied through Vite), so the port must be explicit here.
  const corePort = import.meta.env.VITE_CORE_PORT ?? '3001'
  // Mirror the page protocol: wss:// when the dashboard is served over HTTPS,
  // ws:// otherwise. A mixed-content ws:// on an https page is blocked.
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${window.location.hostname}:${corePort}/ws${qs}`
  socket = new WebSocket(url)

  socket.onopen = () => {
    console.log('[ws] connected')
    emitStatus(true)
    pingInterval = setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), 20_000)
  }

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as WsMessage
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
